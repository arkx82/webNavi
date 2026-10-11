import { createReadStream, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Turn } from "./lanes.js";
import type { LonLat } from "./route/types.js";

/**
 * The arrows painted on the lanes (정밀도로지도's B3_SURFACEMARK /
 * RM2_ROADMARKING, as tools/hdmap/build.py writes them to marks.geojsons):
 * where each one is and what it says, for the lanes at a stop line to be
 * told by their paint first and by where their links go only where there is
 * none. The marks file is 270 MB (crosswalks, stop lines, words …); the
 * arrows alone, a point each, go into a small SQLite R*Tree beside it
 * (arrows.db, some 600 thousand rows), rebuilt when a newer marks file comes.
 */

/**
 * What an arrow's kind says, by the 노면표시 numbering (도로교통법 시행규칙 별표 6, 진행방향 537–539) and as
 * the lanes under them were found to go (2026-10-11: of the arrows at the stop lines of a day's drive,
 * 5373 on every lane whose link turns right off the road, 5372 and 5391 on the left-turn and U-turn pockets):
 * 직진 5371, 좌회전 5372, 우회전 5373, 좌우회전 5374, 직진·좌회전 5381, 직진·우회전 5382, 직진·좌우회전 5383,
 * 유턴 5391, 좌회전·유턴 5392. Others (5379 …) are not read.
 */
export const ARROW_TURNS: Record<number, Turn[]> = {
  5371: ["straight"],
  5372: ["left"],
  5373: ["right"],
  5374: ["left", "right"],
  5381: ["left", "straight"],
  5382: ["straight", "right"],
  5383: ["left", "straight", "right"],
  5391: ["uturn"],
  5392: ["uturn", "left"],
};

/** A marks line whose kind is a direction arrow (537x–539x), told before the line is parsed. */
const ARROW_LINE = /"k":"?(53[789]\d)"?/;

export interface Arrow { code: number; at: LonLat }

/** The middle of a ring by its area (its vertices' mean leans to the arrowhead, where they crowd). */
function centroid(ring: LonLat[]): LonLat | null {
  if (ring.length < 3) return null;
  const o = ring[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const x0 = ring[i][0] - o[0], y0 = ring[i][1] - o[1], x1 = ring[i + 1][0] - o[0], y1 = ring[i + 1][1] - o[1];
    const c = x0 * y1 - x1 * y0;
    a += c;
    cx += (x0 + x1) * c;
    cy += (y0 + y1) * c;
  }
  if (Math.abs(a) < 1e-18) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [o[0] + cx / (3 * a), o[1] + cy / (3 * a)];
}

export class ArrowIndex {
  private db: DatabaseSync | null = null;
  private near: StatementSync | null = null;
  private building = false;

  constructor(private marksFile: string, private dbFile: string, private log: (msg: string) => void = () => {}) {}

  get ready() {
    return !!this.open();
  }

  private open(): StatementSync | null {
    if (this.near) return this.near;
    if (!existsSync(this.dbFile)) return null;
    this.db = new DatabaseSync(this.dbFile, { readOnly: true });
    this.near = this.db.prepare("SELECT code, lon, lat FROM arrows WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?");
    return this.near;
  }

  /** The arrows within the box [w, s, e, n]; none where there is no arrows file. */
  within(w: number, s: number, e: number, n: number): Arrow[] {
    const near = this.open();
    if (!near) return [];
    return (near.all(e, w, n, s) as unknown as { code: number; lon: number; lat: number }[]).map((r) => ({ code: r.code, at: [r.lon, r.lat] }));
  }

  /** Builds arrows.db when the marks file is newer than it; in the background, one at a time. */
  async refresh() {
    if (this.building || !existsSync(this.marksFile)) return;
    if (existsSync(this.dbFile) && statSync(this.dbFile).mtimeMs >= statSync(this.marksFile).mtimeMs) return;
    this.building = true;
    const tmp = `${this.dbFile}.new`;
    let db: DatabaseSync | null = null;
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
      db = new DatabaseSync(tmp);
      db.exec(`
        PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
        CREATE VIRTUAL TABLE arrows USING rtree(id, minx, maxx, miny, maxy, +code INTEGER, +lon REAL, +lat REAL);`);
      const put = db.prepare("INSERT INTO arrows (minx, maxx, miny, maxy, code, lon, lat) VALUES (?, ?, ?, ?, ?, ?, ?)");
      let n = 0;
      db.exec("BEGIN");
      for await (const line of createInterface({ input: createReadStream(this.marksFile) })) {
        const k = ARROW_LINE.exec(line);
        if (!k) continue;
        let f: { geometry: { type: string; coordinates: LonLat[][] | LonLat[][][] } | null };
        try { f = JSON.parse(line); } catch { continue; }
        const g = f.geometry;
        if (!g) continue;
        const ring = g.type === "MultiPolygon" ? (g.coordinates as LonLat[][][])[0]?.[0] : g.type === "Polygon" ? (g.coordinates as LonLat[][])[0] : null;
        const c = ring ? centroid(ring) : null;
        if (!c || !c.every(Number.isFinite)) continue;
        const lon = Math.round(c[0] * 1e7) / 1e7, lat = Math.round(c[1] * 1e7) / 1e7;
        put.run(lon, lon, lat, lat, Number(k[1]), lon, lat);
        if (++n % 200_000 === 0) { db.exec("COMMIT; BEGIN"); this.log(`arrows: ${n}`); }
      }
      db.exec("COMMIT");
      db.close();
      db = null;
      this.near = null;
      this.db?.close();
      this.db = null;
      renameSync(tmp, this.dbFile);
      this.log(`arrows: index built, ${n} arrows`);
    } finally {
      try { db?.close(); } catch { /* already closed */ }
      this.building = false;
    }
  }
}
