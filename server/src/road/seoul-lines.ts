import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import type { LonLat } from "../route/types.js";
import type { GuideColour } from "./color-guides.js";

/**
 * 서울시 노면색깔유도선 위치 현황 (서울 열린데이터광장 OA-22350): where colour
 * guide lines are painted on Seoul's own roads — the city expressways and
 * the big junctions 한국도로공사's list (color-guides.ts) does not cover. A
 * point a line (in the lane's middle: 40 checked against 정밀도로지도, all
 * within 2.2 m of a lane's centre), and no colour. The colour is the
 * manual's (국토교통부 노면 색깔 유도선 설치 및 관리 매뉴얼): the branch away
 * from the centre line — the right one — pink, the nearer left one green,
 * and a way out that is the only one pink. So a right turn on a painted
 * line is pink; a left one is green where another line goes off to its
 * right, else said without a colour.
 */
const PAGE = "https://data.seoul.go.kr/dataList/OA-22350/F/1/datasetView.do";
const DOWNLOAD = "https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?&useCache=false";
const MAX_AGE_MS = 30 * 86_400_000;
const FILE = "seoul-color-lines.csv";
/** A point this near the route's line is a line the route drives on. */
const ON_PATH_M = 4;
/** Another line this near the turn, and this far to the route's right, is the branch beside it. */
const BESIDE_M = 40;
const OFF_PATH_M = 5;

const R = 6_371_008.8;
const RAD = Math.PI / 180;

/** EPSG:5186 (Korea 2000 / Central Belt 2010: GRS80, origin 38°N 127°E, 200 km E, 600 km N) to lon/lat. */
export function tmToLonLat(x: number, y: number): LonLat {
  const a = 6378137, f = 1 / 298.257222101, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const lat0 = 38 * RAD, lon0 = 127 * RAD, FE = 200000, FN = 600000;
  const m = (p: number) => a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * p - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * p)
    + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * p) - ((35 * e2 ** 3) / 3072) * Math.sin(6 * p));
  const mu = (m(lat0) + (y - FN)) / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1);
  const C1 = ep2 * c * c, T1 = t * t, N1 = a / Math.sqrt(1 - e2 * s * s), R1 = (a * (1 - e2)) / (1 - e2 * s * s) ** 1.5, D = (x - FE) / N1;
  const lat = p1 - ((N1 * t) / R1) * ((D * D) / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = lon0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / c;
  return [lon / RAD, lat / RAD];
}

/** The points of the city's file (its X/Y columns), as lon/lat. */
export function parseSeoulLines(text: string): LonLat[] {
  const rows = parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true }) as Record<string, string>[];
  const out: LonLat[] = [];
  for (const r of rows) {
    const x = Number(r["X좌표"]), y = Number(r["Y좌표"]);
    if (Number.isFinite(x) && Number.isFinite(y) && x > 100_000 && y > 400_000) out.push(tmToLonLat(x, y));
  }
  return out;
}

/** Metres east and north of [o]. */
const xy = (p: LonLat, o: LonLat) => [(p[0] - o[0]) * RAD * Math.cos(o[1] * RAD) * R, (p[1] - o[1]) * RAD * R] as const;

/** Where [p] is from the polyline [path]: metres off, and which side (+ right of the way the path runs, - left). */
function offPath(p: LonLat, path: LonLat[]): { off: number; side: number } {
  let best = { off: Infinity, side: 0 };
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = xy(path[i - 1], p), [bx, by] = xy(path[i], p);
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    const qx = ax + t * dx, qy = ay + t * dy, off = Math.hypot(qx, qy);
    // The point is at the origin; the path's way is (dx, dy): the point is right of it when the cross product is negative.
    if (off < best.off) best = { off, side: -(dx * (0 - ay) - dy * (0 - ax)) };
  }
  return best;
}

export class SeoulLines {
  private points: LonLat[] = [];
  private grid = new Map<string, LonLat[]>();
  private loadedAt = 0;

  constructor(private dir: string) {
    const file = join(dir, FILE);
    if (existsSync(file)) { this.use(parseSeoulLines(readFileSync(file, "utf8"))); this.loadedAt = statSync(file).mtimeMs; }
  }

  get ready() {
    return this.points.length > 0;
  }
  get count() {
    return this.points.length;
  }

  private use(points: LonLat[]) {
    this.points = points;
    this.grid = new Map();
    for (const p of points) {
      const k = `${Math.floor(p[0] / 0.002)}:${Math.floor(p[1] / 0.002)}`;
      const l = this.grid.get(k);
      if (l) l.push(p); else this.grid.set(k, [p]);
    }
  }

  /** The file again when a month old (the city updates it now and then). The newest file is the page's first. */
  async refresh() {
    if (this.points.length && Date.now() - this.loadedAt < MAX_AGE_MS) return;
    const page = await (await fetch(PAGE, { signal: AbortSignal.timeout(20_000) })).text();
    const seq = page.match(/downloadFile\('(\d+)'\)/)?.[1];
    if (!seq) throw new Error("seoul lines: no file on the page");
    const a = await fetch(DOWNLOAD, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: PAGE },
      body: `infId=OA-22350&seq=${seq}&infSeq=1`,
      signal: AbortSignal.timeout(60_000),
    });
    const bytes = Buffer.from(await a.arrayBuffer());
    const text = bytes[0] === 0xef && bytes[1] === 0xbb ? bytes.subarray(3).toString("utf8") : new TextDecoder("euc-kr").decode(bytes);
    const points = parseSeoulLines(text);
    if (points.length < 500) throw new Error(`seoul lines: only ${points.length} points`);
    writeFileSync(join(this.dir, FILE), text);
    this.use(points);
    this.loadedAt = Date.now();
  }

  private near(p: LonLat, m: number): LonLat[] {
    const gx = Math.floor(p[0] / 0.002), gy = Math.floor(p[1] / 0.002);
    const out: LonLat[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const q of this.grid.get(`${gx + i}:${gy + j}`) ?? []) {
        const [x, y] = xy(q, p);
        if (Math.hypot(x, y) <= m) out.push(q);
      }
    }
    return out;
  }

  /**
   * The line to follow where the route turns [go] at [at], driving [path] (the route round the turn, a point every
   * few metres): none unless a painted line lies on the route there.
   */
  lineFor(at: LonLat, path: LonLat[], go: "left" | "right"): GuideColour | null {
    if (!this.points.length || path.length < 2) return null;
    const round = this.near(at, 150);
    if (!round.some((q) => offPath(q, path).off <= ON_PATH_M)) return null;
    if (go === "right") return "pink";
    const beside = round.some((q) => { const o = offPath(q, path); return o.off > OFF_PATH_M && o.off <= 15 && o.side > 0 && Math.hypot(...xy(q, at)) <= BESIDE_M; });
    return beside ? "green" : "line";
  }
}
