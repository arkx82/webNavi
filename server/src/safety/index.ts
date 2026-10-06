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
  /** A camera inside a 보호구역 (경찰청's 보호구역구분: 2 어린이, 1 노인): what tells a school zone its limit. */
  zone?: "school" | "senior";
  /** A 구간 단속 camera's other end (the start's end, the end's start): which way along a road its stretch runs. */
  pair?: [number, number];
  /** A 구간 단속 camera's 설치장소, which names its stretch ("…종점(이촌동, 성수JC→원효대교)", "…서울방향 시점"). */
  site?: string;
  /** The carriageways the camera stands on: the way each runs and the camera put on it (safety/roads.ts). */
  ways?: { deg: number; at: [number, number] }[];
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
      // One file that will not parse (a quote left open) is left out, not the whole index — nor the process, when
      // the hourly rebuild meets it with no catch above.
      try {
        const text = decode(readFileSync(join(dir, file)));
        index.add(parseStandardData(text, file));
      } catch (e) {
        console.warn(`safety: ${file} not read: ${(e as Error).message}`);
      }
    }
    return index.build();
  }

  add(features: Feature[]): this {
    // A loop, not push(...): the speed bumps alone are more arguments than a call can take.
    for (const f of features) this.features.push(f);
    return this;
  }

  build(): this {
    zoneLimits(this.features);
    sectionPairs(this.features);
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

/** 경찰청's 보호구역구분 — "2" (or "02", or the words) 어린이, "1" 노인·장애인 — as a zone; undefined outside one. */
export function zoneOf(code: string | undefined): Feature["zone"] {
  const c = (code ?? "").trim().replace(/^0+/, "");
  if (c === "2" || /어린이/.test(c)) return "school";
  if (c === "1" || /노인|장애인/.test(c)) return "senior";
  return undefined;
}

/** A zone's own cameras are looked for this far round it. */
export const ZONE_CAMERA_M = 300;
/** The limits a zone's camera can give it: a 60 or an 80 is the road beside it, not the zone. */
const ZONE_LIMITS = new Set([20, 30, 40, 50, 60]);

/**
 * Each 보호구역's limit, from the enforcement cameras inside one (보호구역구분) round it — not 30 for every school:
 * of the 9,871 school zones with a camera within 300 m, 866 are 40, 50, 60 or 20 (2026-10-04). Where the cameras
 * round it disagree (a 50 arterial at one side of the school, a 30 lane at the other) or there is none, the zone
 * says no limit: the page takes it from a zone camera on its route (web/src/warnings.ts), or says none.
 */
export function zoneLimits(features: Feature[]): void {
  const cell = (lon: number, lat: number) => `${Math.floor(lon * 200)},${Math.floor(lat * 200)}`;
  const cams = new Map<string, Feature[]>();
  for (const f of features) {
    if (!f.zone || !f.limit || !ZONE_LIMITS.has(f.limit)) continue;
    const k = cell(f.lon, f.lat);
    cams.set(k, [...(cams.get(k) ?? []), f]);
  }
  features.forEach((f, i) => {
    const zone = f.kind === "school-zone" ? "school" : f.kind === "senior-zone" ? "senior" : null;
    if (!zone) return;
    const near: { d: number; limit: number }[] = [];
    const [x, y] = [Math.floor(f.lon * 200), Math.floor(f.lat * 200)];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const c of cams.get(`${x + dx},${y + dy}`) ?? []) {
        const d = metres(f.lon, f.lat, c.lon, c.lat);
        if (c.zone === zone && d <= ZONE_CAMERA_M) near.push({ d, limit: c.limit! });
      }
    }
    const limits = new Set(near.map((n) => n.limit));
    // A school zone's 30 was the list's guess, so none is kept; a senior zone's limit is the row's own (datasets.ts), kept.
    features[i] = { ...f, limit: limits.size === 1 ? near[0].limit : f.kind === "senior-zone" ? f.limit : undefined };
  });
}

/** The stretch a 구간 단속 camera's site names: "성수JC→원효대교" of "…(이촌동, 성수JC→원효대교)", "서울방향" of "…256.8k 서울방향 시점". */
export function stretchOf(f: Feature): string | null {
  const site = f.site ?? "";
  const arrow = site.match(/\(([^()]*→[^()]*)\)/)?.[1];
  if (arrow) return arrow.replace(/^[^,]*,\s*/, "").replace(/\s+/g, "");
  const toward = site.match(/(\S+방향)/)?.[1];
  return toward ? `${f.name ?? ""}:${toward.replace(/^\d+(\.\d+)?[kK]/, "")}` : null;
}

/** The shortest a 구간 단속 runs: a start and end nearer than this are the two carriageways' cameras at one place. */
const SECTION_MIN_M = 500;
const SECTION_LONGEST_M = 40_000;

/**
 * Each 구간 단속 camera given its other end, so the page can tell which way the stretch runs: a two-way road has
 * one stretch each way, the start of one by the end of the other, and the data says no bearing. A start's end is
 * the nearest end of its direction code, limit and road (where both name one), at least SECTION_MIN_M off.
 */
export function sectionPairs(features: Feature[]): void {
  const code = (f: Feature) => (f.direction ?? "").trim().replace(/^0+/, "");
  const of = (kind: Kind) => features.filter((f) => f.kind === kind).map((f) => ({ f, key: stretchOf(f) }));
  const starts = of("section-start"), ends = of("section-end");
  const pairs = new Map<Feature, [number, number]>();
  // Each camera finds its own other end (an end its start, as a start its end): a pair given only from the starts'
  // side left an end with whichever start took it first. Where the sites name the stretch, one of the same name:
  // Seoul gives every stretch on a road one direction code, and the nearest end of it was another stretch's
  // (서강대교's start paired with 이촌동's end). A camera whose site names none is paired among those that name none.
  for (const [mine, theirs] of [[starts, ends], [ends, starts]] as const) {
    for (const { f, key } of mine) {
      let pool = theirs.filter(({ f: o }) => code(o) === code(f) && (o.limit ?? 0) === (f.limit ?? 0) && !(f.name && o.name && f.name !== o.name));
      const same = pool.filter((o) => o.key === key);
      if (same.length) pool = same;
      let best: { f: Feature; d: number } | null = null;
      for (const { f: o } of pool) {
        const d = metres(f.lon, f.lat, o.lon, o.lat);
        if (d < SECTION_MIN_M || d > SECTION_LONGEST_M || (best && d >= best.d)) continue;
        best = { f: o, d };
      }
      if (best) pairs.set(f, [best.f.lon, best.f.lat]);
    }
  }
  features.forEach((f, i) => {
    const pair = pairs.get(f);
    if (pair) features[i] = { ...f, pair };
  });
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
      ...(zoneOf(row["보호구역구분"]) ? { zone: zoneOf(row["보호구역구분"]) } : {}),
      ...(kind === "section-start" || kind === "section-end") && row["설치장소"] ? { site: row["설치장소"] } : {},
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
  if (speed && signal) return "speed-signal";
  if (speed) return "speed";
  if (signal) return "signal";
  return null;
}
