import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import type { LonLat } from "../route/types.js";

/**
 * 노면색깔유도선 — the pink and green lines painted where a motorway parts —
 * from 한국도로공사's list of them (공공데이터포털 15118978, a CSV a year):
 * for each junction and direction, the colour of the line to the left
 * branch and to the right. It gives no place, only the junction's name and
 * the town the direction heads for, so a junction is found by the name in
 * the route's guide and its direction by where that town lies.
 */
export type GuideColour = "pink" | "green" | "blue" | "orange";
export interface ColourGuide {
  /** The line to each branch; one alone is the exit's. */
  left?: GuideColour;
  right?: GuideColour;
  facility: string;
  route: string;
  towards: string;
}

const PAGE = "https://www.data.go.kr/data/15118978/fileData.do";
const MAX_AGE_MS = 30 * 86_400_000;
/** How long a town the geocoder could not place stays unasked. */
const MISS_TTL_MS = 10 * 60_000;

export function colourOf(word: string | undefined): GuideColour | undefined {
  const w = (word ?? "").replace(/\s+/g, "");
  if (/분홍/.test(w)) return "pink";
  if (/녹색|초록/.test(w)) return "green";
  if (/청색|파랑|파란/.test(w)) return "blue";
  if (/주황/.test(w)) return "orange";
  return undefined;
}

/**
 * "부평 나들목" and "부평IC" alike, "신갈분기점" and "신갈JC" alike — but 용인
 * 나들목 (IC) is not 용인 분기점 (JC): the name and its kind.
 */
export function junctionKey(name: string): string {
  const n = name.replace(/\s+/g, "");
  const kind = /(나들목|IC)$/i.test(n) ? "IC" : /(분기점|JC)$/i.test(n) ? "JC" : /(요금소|영업소|톨게이트|TG)$/i.test(n) ? "TG" : "";
  return `${n.replace(/(나들목|분기점|IC|JC|교차로|요금소|영업소|톨게이트|TG)$/i, "")}|${kind}`;
}

/** "영동선", "서울외곽순환선" → "영동", "서울외곽순환": a motorway's name as the guides write it before 고속도로. */
export function routeCore(route: string): string {
  return route.replace(/\s+/g, "").replace(/(고속도로|고속국도|선)$/, "");
}

interface Row { route: string; facility: string; towards: string; left?: GuideColour; right?: GuideColour; kind: string }

export function parseGuides(text: string): Row[] {
  const rows = parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true }) as Record<string, string>[];
  return rows
    .map((r) => ({
      route: (r["노선명"] ?? "").trim(),
      facility: (r["시설물 명칭"] ?? "").trim(),
      towards: (r["방향"] ?? "").trim(),
      left: colourOf(r["좌"]),
      right: colourOf(r["우"]),
      kind: `${r["분기형태"] ?? ""} ${r["비고"] ?? ""}`,
    }))
    // Toll plazas are left out: what their colours mean (하이패스 or not) the list does not say.
    .filter((r) => r.facility && (r.left || r.right) && !/영업소/.test(r.kind));
}

export class ColourGuides {
  private rows: Row[] = [];
  private loadedAt = 0;
  /** Towns placed, for good; a town not placed only for ten minutes, the geocoder may have been down. */
  private places = new Map<string, { at: LonLat | null; until: number }>();

  constructor(private dir: string, private geocode: (town: string, near: LonLat) => Promise<LonLat | null>) {
    const file = join(dir, "color-guides.csv");
    if (existsSync(file)) { this.rows = parseGuides(readFileSync(file, "utf8")); this.loadedAt = statSync(file).mtimeMs; }
  }

  get ready() {
    return this.rows.length > 0;
  }

  /** The list again when a month old: its page names the current file. */
  async refresh() {
    if (this.rows.length && Date.now() - this.loadedAt < MAX_AGE_MS) return;
    const page = await (await fetch(PAGE, { signal: AbortSignal.timeout(20_000) })).text();
    const link = page.match(/fileDownload\.do\?atchFileId=(FILE_\d+)&fileDetailSn=(\d+)/);
    if (!link) throw new Error("color guides: no file on the page");
    const a = await fetch(`https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=${link[1]}&fileDetailSn=${link[2]}&insertDataPrcus=N`, { headers: { Referer: PAGE }, signal: AbortSignal.timeout(60_000) });
    const bytes = Buffer.from(await a.arrayBuffer());
    // EUC-KR, as the portal's CSVs mostly are; UTF-8 when it says so with a BOM.
    const text = bytes[0] === 0xef && bytes[1] === 0xbb ? bytes.subarray(3).toString("utf8") : new TextDecoder("euc-kr").decode(bytes);
    const rows = parseGuides(text);
    if (rows.length < 100) throw new Error(`color guides: only ${rows.length} rows`);
    writeFileSync(join(this.dir, "color-guides.csv"), text);
    this.rows = rows;
    this.loadedAt = Date.now();
  }

  /**
   * The lines at the junction named [name] at [at], for a car coming in
   * heading [inDeg]: of its rows (one a direction), the one whose town lies
   * ahead. Null where the list has none, or the directions disagree and
   * the town cannot be placed.
   */
  async at(name: string, at: LonLat, inDeg: number, roads: string[] = []): Promise<ColourGuide | null> {
    const key = junctionKey(name);
    if (key.length < 3) return null;
    let rows = this.rows.filter((r) => junctionKey(r.facility) === key);
    if (rows.length === 0) return null;
    // The motorway the route is on (its guides say "영동 고속도로를 따라"): that line's rows, where it has some.
    const hints = roads.map(routeCore).filter((h) => h.length >= 2);
    const onRoad = rows.filter((r) => hints.some((h) => routeCore(r.route).includes(h) || h.includes(routeCore(r.route))));
    if (onRoad.length) rows = onRoad;
    const same = rows.every((r) => r.left === rows[0].left && r.right === rows[0].right);
    let pick: Row | null = same ? rows[0] : null;
    if (!pick) {
      let best = 181;
      for (const r of rows) {
        const town = await this.place(r.towards, at);
        if (!town) continue;
        const d = Math.abs(((bearing(at, town) - inDeg + 540) % 360) - 180);
        if (d < best) { best = d; pick = r; }
      }
      if (best > 100) pick = null;
    }
    return pick ? { left: pick.left, right: pick.right, facility: pick.facility, route: pick.route, towards: pick.towards } : null;
  }

  private async place(town: string, near: LonLat): Promise<LonLat | null> {
    if (!town) return null;
    const had = this.places.get(town);
    if (had && Date.now() < had.until) return had.at;
    const at = await this.geocode(town, near).catch(() => null);
    this.places.set(town, { at, until: at ? Infinity : Date.now() + MISS_TTL_MS });
    return at;
  }
}

function bearing(a: LonLat, b: LonLat): number {
  const r = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}
