import Flatbush from "flatbush";
import { parse } from "csv-parse/sync";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the road has in store: enforcement cameras, speed bumps, school
 * zones — every kind in one index, since the question is always "what is
 * within r metres of here", never "which cameras".
 */
export type Kind =
  | "speed" | "signal" | "speed-signal" | "section-start" | "section-end" | "bump" | "school" | "accident" | "bike-accident"
  | "school-zone" | "incident-crash" | "incident-work" | "incident-other" | "rest-area" | "merge" | "signal-light" | "senior-zone" | "other";

export interface Feature {
  id: string;
  kind: Kind;
  lon: number;
  lat: number;
  /** km/h, where the source says. */
  limit?: number;
  /** Free text the source gave for the road direction ("상행", "동쪽" …); no bearing is published. */
  direction?: string;
  name?: string;
  /** For an area rather than a point (an accident hotspot, a school zone): how far round the centre it reaches. */
  radiusM?: number;
  /** A line under the name, for the screen: the lanes an incident closes, a school zone's facility. */
  detail?: string;
  /** A traffic light's flashing hours: "00:00-05:00" (KST), or "always" for a flashing-yellow lamp. */
  flash?: string;
}

const M_PER_DEG_LAT = 111_320;

export class SafetyIndex {
  private tree: Flatbush | null = null;
  readonly features: Feature[] = [];

  /** Loads every CSV in [dir]; the file name says which loader applies. */
  static fromDirectory(dir: string): SafetyIndex {
    const index = new SafetyIndex();
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv"));
    } catch {
      return index.build();
    }
    for (const file of files) {
      const text = decode(readFileSync(join(dir, file)));
      index.add(parseStandardData(text, file));
    }
    return index.build();
  }

  add(features: Feature[]): this {
    // A loop, not push(...): the speed bumps alone are more arguments than a call can take.
    for (const f of features) this.features.push(f);
    return this;
  }

  build(): this {
    if (this.features.length === 0) {
      this.tree = null;
      return this;
    }
    const tree = new Flatbush(this.features.length);
    for (const f of this.features) tree.add(f.lon, f.lat, f.lon, f.lat);
    tree.finish();
    this.tree = tree;
    return this;
  }

  /** Everything within [radiusM] of the point, nearest first. */
  near(lon: number, lat: number, radiusM: number): (Feature & { distanceM: number })[] {
    if (!this.tree) return [];
    const dLat = radiusM / M_PER_DEG_LAT;
    const dLon = radiusM / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
    const found = this.tree.search(lon - dLon, lat - dLat, lon + dLon, lat + dLat);
    const out: (Feature & { distanceM: number })[] = [];
    for (const i of found) {
      const f = this.features[i];
      const d = metres(lon, lat, f.lon, f.lat);
      if (d <= radiusM) out.push({ ...f, distanceM: Math.round(d) });
    }
    return out.sort((a, b) => a.distanceM - b.distanceM);
  }
}

/** Equirectangular distance; fine under a few kilometres. */
export function metres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const x = (lon2 - lon1) * M_PER_DEG_LAT * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const y = (lat2 - lat1) * M_PER_DEG_LAT;
  return Math.hypot(x, y);
}

/** data.go.kr ships EUC-KR as often as UTF-8; a BOM or a decode failure tells them apart. */
function decode(bytes: Buffer): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString("utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

/**
 * The 표준데이터 CSVs share a habit: a header row with the columns named in
 * Korean, 위도/경도 among them. The rest is read by name where a column
 * exists, so a schema change costs a row's field, not the whole file.
 */
export function parseStandardData(text: string, file: string): Feature[] {
  const rows = parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true }) as Record<string, string>[];
  return featuresOf(rows, file, /방지턱/.test(file));
}

/** Rows with the standard data's Korean column names, into features; rows without a position are dropped. */
export function featuresOf(rows: Record<string, string | undefined>[], source: string, bumps = false): Feature[] {
  const out: Feature[] = [];
  rows.forEach((row, n) => {
    const lat = Number(row["위도"]);
    const lon = Number(row["경도"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0 || lon === 0) return;
    const limit = Number(row["제한속도"]);
    const kind = bumps ? "bump" : cameraKind(row["단속구분"], row["보호구역구분"], row["단속구간위치구분"]);
    // Cameras a driver on the move is not warned of: parking, bus lanes, the unexplained.
    if (!kind) return;
    out.push({
      id: `${source}:${row["무인교통단속카메라관리번호"] ?? row["과속방지턱관리번호"] ?? n}`,
      kind,
      lon, lat,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      direction: row["도로노선방향"] || undefined,
      name: row["도로노선명"] || row["도로명"] || row["설치장소"] || undefined,
    });
  });
  return out;
}

/**
 * What a camera is, from the standard data: 단속구분 1 속도, 2 신호,
 * 3 불법주정차, 4 버스전용차로, 99 기타 — written "1", "01", "01+02" or in
 * words — and 단속구간위치구분 1 시점, 2 종점 for a 구간 단속, which is
 * what makes one a section whatever its 단속구분 says. Null for the kinds a
 * moving car is not warned of.
 */
export function cameraKind(code: string | undefined, zone: string | undefined, section?: string): Kind | null {
  const pos = (section ?? "").trim().replace(/^0+/, "");
  if (pos === "1" || /시점/.test(pos)) return "section-start";
  if (pos === "2" || /종점/.test(pos)) return "section-end";
  const text = (code ?? "").trim();
  const parts = new Set(text.split(/[+,/\s]+/).map((p) => p.replace(/^0+/, "")));
  const speed = parts.has("1") || /속도|과속/.test(text);
  const signal = parts.has("2") || /신호/.test(text);
  if (/구간.*시/.test(text)) return "section-start";
  if (/구간.*종/.test(text)) return "section-end";
  if (zone && /어린이/.test(zone) && speed) return "school";
  if (speed && signal) return "speed-signal";
  if (speed) return "speed";
  if (signal) return "signal";
  return null;
}
