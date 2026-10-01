import { createReadStream, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { LonLat } from "./route/types.js";

/**
 * Lanes at a junction, from 정밀도로지도's lane-level links (A2_LINK /
 * NT2_LINK, as tools/hdmap/build.py writes them): how many lanes the road
 * has at the stop line, where each may go (from the links that carry on
 * through the junction), and which of them keep to the route. Not where
 * the car is — no GPS tells a lane — but which lanes to be in, as the car
 * apps show [↰ | ↑ | ↑ | ↱] with the right ones lit.
 *
 * The links go into SQLite with an R*Tree, rebuilt when a new links file
 * comes, so a query reads a few rows, not the country.
 */
export type Turn = "uturn" | "left" | "straight" | "right";
export interface LaneInfo {
  /** Left to right: each lane's ways on, and whether it keeps to the route. */
  lanes: { turns: Turn[]; best: boolean }[];
  /** Metres from the junction back to the stop line these lanes end at. */
  stopM: number;
  /** Where that stop line is (the lane the route comes down, its end). */
  stop?: LonLat;
}

interface Link { rowid: number; id: string | null; lane: number | null; a: string | null; b: string | null; l: string | null; r: string | null; coords: string }

const M = 111_320;
const toXY = (p: LonLat, o: LonLat) => [(p[0] - o[0]) * M * Math.cos((o[1] * Math.PI) / 180), (p[1] - o[1]) * M] as const;
const bearingOf = (a: LonLat, b: LonLat) => {
  const [x, y] = toXY(b, a);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
};
const diff = (a: number, b: number) => ((b - a + 540) % 360) - 180;
const dist = (a: LonLat, b: LonLat) => Math.hypot(...toXY(a, b));

/** The way from the lane's end to where its link on through the junction goes. */
export function turnOf(inDeg: number, outDeg: number): Turn {
  const d = diff(inDeg, outDeg);
  if (Math.abs(d) > 140) return "uturn";
  if (d < -30) return "left";
  if (d > 30) return "right";
  return "straight";
}

/**
 * The survey's year in a link's ID: A2 + YY + sheet (A219A…: 2019), or NT +
 * a layer digit + YY + sheet (NT2259F…: 2025). 0 where there is no ID or
 * no year in it, so the link never counts as the newest.
 */
export function surveyYear(id: string | null | undefined): number {
  if (!id) return 0;
  const yy = id.startsWith("NT") ? id.slice(3, 5) : id.slice(2, 4);
  return /^\d\d$/.test(yy) ? Number(yy) : 0;
}

/** Metres from [p] to the polyline [line]. */
function offLine(p: LonLat, line: LonLat[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = toXY(line[i], p), [bx, by] = toXY(line[i + 1], p);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** A point [m] metres along [path]. */
function along(path: LonLat[], m: number): LonLat {
  let left = m;
  for (let i = 0; i + 1 < path.length; i++) {
    const d = dist(path[i], path[i + 1]);
    if (d >= left) {
      const t = d === 0 ? 0 : left / d;
      return [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t];
    }
    left -= d;
  }
  return path[path.length - 1];
}

/** How much of the route after a junction the lanes are read against: 40 points, 600 m or so. */
export const AFTER_POINTS = 40;

interface Statements { byId: StatementSync; near: StatementSync; next: StatementSync }
type End = Link & { path: LonLat[]; end: LonLat; before: number; side: number };
/** How far past the stop line a corner is threaded, and how close to the route its links must keep. */
const THREAD_M = 150;
const THREAD_OFF_M = 6;
/** A lane's end this close to the next link's start is the same point, surveyed twice. */
const TRAIL_JOIN_M = 3;
/** A lane within this of a route vertex, running within SNAP_DEG of the route's way, is the road's; lanes within CARRIAGEWAY_M of the nearest are one carriageway. */
const SNAP_M = 15;
const SNAP_DEG = 25;
const CARRIAGEWAY_M = 12;

/** The nearest point of [line] to [p], how far it is, and the line's bearing there. */
function nearestOn(p: LonLat, line: LonLat[]): { at: LonLat; off: number; bearing: number } | null {
  let best: { at: LonLat; off: number; bearing: number } | null = null;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = toXY(line[i], p), [bx, by] = toXY(line[i + 1], p);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (!best || off < best.off) {
      best = { at: [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t], off, bearing: bearingOf(line[i], line[i + 1]) };
    }
  }
  return best;
}

export class LaneIndex {
  private db: DatabaseSync | null = null;
  /** Prepared once for each opening of the database; gone with it. */
  private stmts: Statements | null = null;
  private building = false;

  constructor(private linksFile: string, private dbFile: string, private log: (msg: string) => void = () => {}) {}

  get ready() {
    return !!this.open();
  }

  private open(): Statements | null {
    if (this.stmts) return this.stmts;
    if (!existsSync(this.dbFile)) return null;
    this.db = new DatabaseSync(this.dbFile, { readOnly: true });
    this.stmts = {
      byId: this.db.prepare("SELECT rowid, * FROM links WHERE id = ?"),
      near: this.db.prepare("SELECT l.rowid, l.* FROM box b JOIN links l ON l.rowid = b.rowid WHERE b.minx <= ? AND b.maxx >= ? AND b.miny <= ? AND b.maxy >= ?"),
      next: this.db.prepare("SELECT rowid, * FROM links WHERE a = ?"),
    };
    return this.stmts;
  }

  /** Builds the index when the links file is newer than it; in the background, one at a time. */
  async refresh() {
    if (this.building || !existsSync(this.linksFile)) return;
    if (existsSync(this.dbFile) && statSync(this.dbFile).mtimeMs >= statSync(this.linksFile).mtimeMs) return;
    this.building = true;
    const tmp = `${this.dbFile}.new`;
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
      const db = new DatabaseSync(tmp);
      db.exec(`
        PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
        CREATE TABLE links (rowid INTEGER PRIMARY KEY, id TEXT, lane INTEGER, a TEXT, b TEXT, l TEXT, r TEXT, coords TEXT);
        CREATE VIRTUAL TABLE box USING rtree(rowid, minx, maxx, miny, maxy);`);
      const put = db.prepare("INSERT INTO links (id, lane, a, b, l, r, coords) VALUES (?, ?, ?, ?, ?, ?, ?)");
      const boxed = db.prepare("INSERT INTO box VALUES (?, ?, ?, ?, ?)");
      let n = 0;
      db.exec("BEGIN");
      for await (const line of createInterface({ input: createReadStream(this.linksFile) })) {
        if (!line.trim()) continue;
        let f: { properties: Record<string, string | number | null>; geometry: { type: string; coordinates: LonLat[] | LonLat[][] } | null };
        try { f = JSON.parse(line); } catch { continue; }
        const g = f.geometry;
        if (!g) continue;
        const coords = (g.type === "MultiLineString" ? (g.coordinates as LonLat[][]).flat() : (g.coordinates as LonLat[])).map((c) => [Math.round(c[0] * 1e7) / 1e7, Math.round(c[1] * 1e7) / 1e7] as LonLat);
        if (coords.length < 2) continue;
        const p = f.properties;
        const s = (v: unknown) => (v == null || v === "" ? null : String(v));
        const r = put.run(s(p.id), p.lane == null ? null : Number(p.lane), s(p.a), s(p.b), s(p.l), s(p.r), JSON.stringify(coords));
        const xs = coords.map((c) => c[0]), ys = coords.map((c) => c[1]);
        boxed.run(r.lastInsertRowid, Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys));
        if (++n % 200_000 === 0) { db.exec("COMMIT; BEGIN"); this.log(`lanes: ${n} links`); }
      }
      db.exec("COMMIT; CREATE INDEX links_id ON links(id); CREATE INDEX links_a ON links(a);");
      db.close();
      this.stmts = null;
      this.db?.close();
      this.db = null;
      renameSync(tmp, this.dbFile);
      this.log(`lanes: index built, ${n} links`);
    } finally {
      this.building = false;
    }
  }

  private byId(db: Statements, id: string | null): Link | null {
    return id ? ((db.byId.get(id) as unknown as Link | undefined) ?? null) : null;
  }

  /**
   * The lanes that meet the junction at [at] coming in heading [inDeg], and
   * which of them carry on along [after] (the route's next 150 m or so).
   */
  /**
   * [way] is the provider's word for the turn (좌회전 → left …); "fork" for a keep-left or
   * keep-right, where every lane goes on ahead and the one to be in is told by the route's shape.
   */
  /**
   * Lanes that end at a stop line near [at] (the guide can be placed a little before or after it),
   * heading in at [inDeg]; of one survey where several overlap (2019's and 2023's of the same streets:
   * the newest, by the year in the IDs).
   */
  private endsNear(db: Statements, at: LonLat, inDeg: number): End[] {
    const d = 80 / M, k = d / Math.cos((at[1] * Math.PI) / 180);
    const near = db.near.all(at[0] + k, at[0] - k, at[1] + d, at[1] - d) as unknown as Link[];
    const dir: LonLat = [Math.sin((inDeg * Math.PI) / 180), Math.cos((inDeg * Math.PI) / 180)];
    let ends: End[] = [];
    for (const l of near) {
      const path = JSON.parse(l.coords) as LonLat[];
      const end = path[path.length - 1];
      let i = path.length - 2;
      while (i > 0 && dist(path[i], end) < 5) i--;
      if (Math.abs(diff(inDeg, bearingOf(path[i], end))) > 35) continue;
      const [x, y] = toXY(end, at);
      const before = -(x * dir[0] + y * dir[1]);
      const side = x * dir[1] - y * dir[0];
      if (before < -70 || before > 70 || Math.abs(side) > 25) continue;
      ends.push({ ...l, path, end, before, side });
    }
    if (ends.length === 0) return ends;
    const newest = Math.max(...ends.map((e) => surveyYear(e.id)));
    return ends.filter((e) => surveyYear(e.id) === newest);
  }

  /**
   * The lane links through the junction at [at] along the route's way: from
   * a lane's end at the stop line, the links on that keep nearest [after]
   * (the route's next 150 m), as one line — the corner as the road is
   * painted, for the route's own line to take instead of the provider's
   * straight cut across it. Null where no lane's way on follows the route
   * closely (within THREAD_OFF_M on average).
   */
  thread(at: LonLat, inDeg: number, after: LonLat[]): LonLat[] | null {
    const db = this.open();
    if (!db || after.length < 2) return null;
    const ends = this.endsNear(db, at, inDeg);
    let best: { trail: LonLat[]; off: number } | null = null;
    for (const seed of ends) {
      for (const s of (seed.b ? (db.next.all(seed.b) as unknown as Link[]) : [])) {
        // Through the junction and on, each hop the link that stays nearest the route.
        let trail = JSON.parse(s.coords) as LonLat[];
        let last: Link = s;
        for (let hop = 0; hop < 6 && lengthOf(trail) < THREAD_M && last.b; hop++) {
          const on = db.next.all(last.b) as unknown as Link[];
          if (on.length === 0) break;
          const pick = on.reduce((a, b) => (offLine(along(JSON.parse(a.coords) as LonLat[], 25), after) <= offLine(along(JSON.parse(b.coords) as LonLat[], 25), after) ? a : b));
          trail = trail.concat((JSON.parse(pick.coords) as LonLat[]).slice(1));
          last = pick;
        }
        const total = lengthOf(trail);
        if (total < 20) continue;
        const probes: number[] = [];
        for (let m = 10; m <= Math.min(total, THREAD_M); m += 10) probes.push(offLine(along(trail, m), after));
        const off = probes.reduce((a, d) => a + d, 0) / probes.length;
        if (off < (best?.off ?? THREAD_OFF_M)) // From the lane's end — unless the next link starts a step beside it (another lane's survey), when it starts there.
        best = { trail: dist(seed.end, trail[0]) < TRAIL_JOIN_M ? trail : [seed.end, ...trail], off };
      }
    }
    return best?.trail ?? null;
  }

  /**
   * Where the travel-direction lanes are at each of [points] (a route's
   * vertices, each with the route's heading there): the middle of the
   * lanes running the same way within SNAP_M, as a point — null where
   * there are none (no 정밀도로지도 here, or only the other way's lanes).
   * The route's line is moved onto it: on a road drawn with both ways'
   * lanes, the line then runs on the side the car is on.
   */
  snap(points: LonLat[], headings: number[]): (LonLat | null)[] {
    const db = this.open();
    if (!db) return points.map(() => null);
    // A link's line parsed once a call: neighbouring vertices see the same links, and the parse is most of the cost.
    const lines = new Map<number, LonLat[]>();
    const lineOf = (l: Link) => { let v = lines.get(l.rowid); if (!v) { v = JSON.parse(l.coords) as LonLat[]; lines.set(l.rowid, v); } return v; };
    return points.map((p, i) => {
      const heading = headings[i];
      if (!Number.isFinite(heading)) return null;
      const d = SNAP_M / M, k = d / Math.cos((p[1] * Math.PI) / 180);
      const near = db.near.all(p[0] + k, p[0] - k, p[1] + d, p[1] - d) as unknown as Link[];
      const found: { at: LonLat; off: number; year: number }[] = [];
      for (const l of near) {
        const hit = nearestOn(p, lineOf(l));
        if (!hit || hit.off > SNAP_M || Math.abs(diff(heading, hit.bearing)) > SNAP_DEG) continue;
        found.push({ at: hit.at, off: hit.off, year: surveyYear(l.id) });
      }
      if (found.length === 0) return null;
      // One survey where several overlap; then the lanes of this carriageway: those within a road's width of the nearest.
      const newest = Math.max(...found.map((f) => f.year));
      const ours = found.filter((f) => f.year === newest);
      const least = Math.min(...ours.map((f) => f.off));
      const row = ours.filter((f) => f.off <= least + CARRIAGEWAY_M);
      return [row.reduce((s, f) => s + f.at[0], 0) / row.length, row.reduce((s, f) => s + f.at[1], 0) / row.length];
    });
  }

  lanes(at: LonLat, inDeg: number, after: LonLat[], way: Turn | "fork" | null = null): LaneInfo | null {
    const db = this.open();
    // A keep-left or keep-right is not shown yet: the lanes there did not read true enough to trust.
    if (!db || way === "fork") return null;
    const ends = this.endsNear(db, at, inDeg);
    if (ends.length === 0) return null;
    const next = db.next;
    const readRow = (seed: End) => {
      const row: Link[] = [seed];
      const withEnd = (l: Link | null) => {
        if (!l) return null;
        const p = JSON.parse(l.coords) as LonLat[];
        return dist(p[p.length - 1], seed.end) < 40 ? l : null;
      };
      for (let l = withEnd(this.byId(db, seed.l)), guard = 0; l && guard < 12; l = withEnd(this.byId(db, l.l)), guard++) row.unshift(l);
      for (let r = withEnd(this.byId(db, seed.r)), guard = 0; r && guard < 12; r = withEnd(this.byId(db, r.r)), guard++) row.push(r);
      const read = row.map((lane) => {
        const path = JSON.parse(lane.coords) as LonLat[];
        const end = path[path.length - 1];
        const turns = new Set<Turn>();
        /** How far this lane's way on stays from the route (its nearest link through), and how much it pulls away: 120 m on against 30 m. */
        let off = Infinity, grows = Infinity;
        for (const s of (lane.b ? (next.all(lane.b) as unknown as Link[]) : [])) {
          // Where the link through the junction heads, 40 m on (or at its end), and the links after it to 150 m.
          let trail = JSON.parse(s.coords) as LonLat[];
          let last: Link = s;
          for (let hop = 0; hop < 4 && lengthOf(trail) < 150 && last.b; hop++) {
            const on = next.all(last.b) as unknown as Link[];
            if (on.length === 0) break;
            const heading = bearingOf(trail[trail.length - 2], trail[trail.length - 1]);
            const pick = on.reduce((a, b) => (Math.abs(diff(heading, firstDeg(a))) <= Math.abs(diff(heading, firstDeg(b))) ? a : b));
            trail = trail.concat((JSON.parse(pick.coords) as LonLat[]).slice(1));
            last = pick;
          }
          turns.add(turnOf(inDeg, bearingOf(end, along(trail, Math.min(40, lengthOf(trail))))));
          if (after.length >= 2) {
            const probes = [30, 60, 90, 120].filter((m) => m <= lengthOf(trail)).map((m) => offLine(along(trail, m), after));
            if (probes.length) {
              off = Math.min(off, probes.reduce((a, d) => a + d, 0) / probes.length);
              grows = Math.min(grows, probes[probes.length - 1] - probes[0]);
            }
          }
        }
        return { turns: order([...turns]), off, grows };
      });
      // The lanes to be in: those going the route's way after the junction; where every lane goes
      // that way (a motorway fork, a straight road), the ones whose way on stays nearest the route.
      const told = way ?? routeTurn(inDeg, after, seed.before);
      const going = read.filter((l) => told && l.turns.includes(told));
      const byWay = going.length > 0 && going.length < read.length;
      // At a fork, the lanes whose way on does not pull away from the route.
      const least = Math.min(...read.map((l) => l.grows));
      const lanes = read.map((l) => ({
        turns: l.turns,
        best: byWay ? l.turns.includes(told!) : Number.isFinite(least) && l.grows <= least + 2.5 && read.length > 1,
      }));
      // A fork only where some lanes' ways on pull 5 m and more further off the route than others' within 120 m.
      const grows = read.map((l) => l.grows).filter(Number.isFinite);
      const parts = grows.length > 1 && Math.max(...grows) - Math.min(...grows) > 5;
      // Whether these lanes can take the route's way at all: a stop line where none can is another road's.
      return { lanes, fits: told ? read.some((l) => l.turns.includes(told)) : parts };
    };
    // Stop lines nearest the guide first; the one where the lanes part (a turn, or the route taking
    // only some of them) is the junction meant — a stretch where every lane goes straight on is not.
    const seen = new Set<string>();
    let fitting: { lanes: LaneInfo["lanes"]; seed: End } | null = null;
    for (const seed of ends.sort((a, b) => Math.abs(a.before) + Math.abs(a.side) * 1.5 - (Math.abs(b.before) + Math.abs(b.side) * 1.5))) {
      const key = `${Math.round(seed.before / 8)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { lanes, fits } = readRow(seed);
      if (!fits || lanes.length < 2 || lanes.some((l) => l.turns.length === 0)) continue;
      fitting ??= { lanes, seed };
      const parts = lanes.some((l) => l.turns.some((t) => t !== "straight")) || (lanes.some((l) => l.best) && lanes.some((l) => !l.best));
      if (parts) return { lanes, stopM: Math.round(seed.before), stop: seed.end };
    }
    // Nowhere the lanes part and can take the route's way: nothing is better than a wrong lane.
    if (!fitting || !fitting.lanes.some((l) => l.best) || fitting.lanes.every((l) => l.best)) return null;
    const { lanes, seed } = fitting;
    return { lanes, stopM: Math.round(seed.before), stop: seed.end };
  }
}

/** The way the route goes at the junction: its heading from a little before the stop line to 60 m past it. */
function routeTurn(inDeg: number, after: LonLat[], stopBefore: number): Turn | null {
  if (after.length < 2) return null;
  const from = Math.max(0, -stopBefore);
  const a = along(after, from), b = along(after, from + 60);
  if (dist(a, b) < 20) return null;
  return turnOf(inDeg, bearingOf(a, b));
}

/**
 * The junctions along [path] (the route ahead, a point every 15 m or so)
 * where some lanes cannot go the route's way — the straight-and-left lane
 * that is left-only at the stop line, the right lane that must turn — each
 * with its lanes and where its stop line is. Asked of every 30 m of the
 * path; one stop line reported once.
 */
export function lanesAlong(index: LaneIndex, path: LonLat[]): (LaneInfo & { stop: LonLat; way: Turn })[] {
  const out: (LaneInfo & { stop: LonLat; way: Turn })[] = [];
  const seen: LonLat[] = [];
  let walked = 0;
  for (let i = 1; i < path.length - 1; i++) {
    walked += dist(path[i - 1], path[i]);
    if (walked < 30) continue;
    walked = 0;
    const back = path[Math.max(0, i - 2)];
    const inDeg = bearingOf(back, path[i]);
    // First where the stop line is, then the route's way from it (60 m on), then the lanes for that way.
    // The route on from here, as far as the lanes are read (the guide asks the same 40 points).
    const after = path.slice(i, i + AFTER_POINTS);
    const found = index.lanes(path[i], inDeg, after, null);
    if (!found?.stop || seen.some((s) => dist(s, found.stop!) < 25)) continue;
    seen.push(found.stop);
    let k = i;
    while (k < path.length - 1 && dist(path[k], found.stop) > dist(path[k + 1], found.stop)) k++;
    let m = k;
    while (m < path.length - 1 && dist(path[k], path[m]) < 60) m++;
    if (dist(path[k], path[m]) < 30) continue;
    const way = turnOf(inDeg, bearingOf(path[k], path[m]));
    const info = index.lanes(path[i], inDeg, after, way);
    if (!info?.stop || info.lanes.length < 2) continue;
    // Only where it matters: some lane at the stop line cannot go the route's way.
    if (info.lanes.every((l) => l.turns.includes(way))) continue;
    out.push({ ...(info as LaneInfo & { stop: LonLat }), way });
  }
  return out;
}

function lengthOf(path: LonLat[]): number {
  let m = 0;
  for (let i = 0; i + 1 < path.length; i++) m += dist(path[i], path[i + 1]);
  return m;
}
function firstDeg(l: Link): number {
  const p = JSON.parse(l.coords) as LonLat[];
  return bearingOf(p[0], p[Math.min(p.length - 1, 2)]);
}
const ORDER: Turn[] = ["uturn", "left", "straight", "right"];
const order = (t: Turn[]) => t.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
