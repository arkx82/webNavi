import { createReadStream, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { ARROW_TURNS, type ArrowIndex } from "./arrows.js";
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
/** A lane found beside a route's vertex (LaneIndex.snap): where on it, how far off, and its link from [seg] on. */
interface Found { at: LonLat; off: number; year: number; id: string | null; l: string | null; r: string | null; link: Link; seg: number }
type End = Link & { path: LonLat[]; end: LonLat; before: number; side: number };
/** How far past the stop line a corner is threaded, and how close to the route its links must keep. */
const THREAD_M = 150;
const THREAD_OFF_M = 6;
/** threadAlong: the route sampled this often; seeds this close to it and this near its way; the trail judged to this far past the turn. */
const ALONG_STEP_M = 5;
const SEED_M = 12;
const SEED_DEG = 30;
const ALONG_PAST_M = 120;
/** On average this close to the route, never further than MAX, ending within END, and no link of it straying past STRAY. */
const ALONG_MEAN_M = 10;
const ALONG_MAX_M = 22;
const ALONG_END_M = 14;
const ALONG_STRAY_M = 25;
/** Where the map ends after the turn, the trail must be this far past the guide (the turn done, on the street's way). */
const ALONG_MAP_ENDS_M = 15;
/**
 * A right turn's slip lane (우회전 전용, 도류화) passes the corner wide, inside it: a way this much further from the
 * route's corner than the nearest way is one. Where there is one it is the turn's — the provider's line through the
 * middle of the junction, which the nearest way follows, is not where a car turning right goes.
 */
export const SLIP_EXTRA_M = 6;
/** How near [trail] comes to [corner] (the route's turn point). */
export function cornerGap(trail: LonLat[], corner: LonLat): number {
  return Math.min(...resample(trail, 2).map((p) => dist(p, corner)));
}
/** Whether the way in [inDeg] and the way out (from [at] along [after]) make a right turn. */
export function turnsRight(inDeg: number, at: LonLat, after: LonLat[]): boolean {
  const out = along(after, 30);
  const bend = diff(inDeg, bearingOf(at, out));
  return bend > 30 && bend < 150;
}
/** Ways tried at most, a corner (a junction's lanes branch, and a slip lane's again). */
const ALONG_TRIES = 400;
/** A lane's end this close to the next link's start is the same point, surveyed twice. */
const TRAIL_JOIN_M = 3;
/**
 * Where one survey's links meet another's (2023's road up to 2022's junction: 언주로 northbound into 경복아파트
 * 사거리, 2026-10-13) no link's end node is the next one's start: a link that starts within this of the end, the same
 * way on, takes its place — or the walk stopped 43 m short and the slip lane the route turned through was never found.
 */
const SEAM_M = 6;
const SEAM_DEG = 30;
/** A lane within this of a route vertex, running within SNAP_DEG of the route's way, is the road's; lanes within CARRIAGEWAY_M of the nearest are one carriageway. */
const SNAP_M = 15;
const SNAP_DEG = 25;
const CARRIAGEWAY_M = 12;
/**
 * A lane the line is put on must be the route's road's: followed on (its links after it, the one nearest the route at
 * each end) for FOLLOW_M — or, near a turn, to the end of the stretch held to the turn's side, up to FOLLOW_MAX_M —
 * and back along its own link for FOLLOW_BACK_M, it may not leave the road: no further from the route than
 * FOLLOW_LEAVE_M, and no more than FOLLOW_GROW_M further than it is here. An outermost lane is often another road's:
 * a deceleration lane running 350 m beside the motorway before it leaves for another exit, a loop ramp that has just
 * come alongside — taken for the turn's side, the line rode them and hooked back (북부간선도로 → 구리IC, 2026-10-13).
 * Within the road the route's own line may cross several lanes (a provider's centre line heading for a fork on the
 * far side): a lane a few metres further off later is still the road's, and the line keeps to it.
 */
const FOLLOW_M = 150;
const FOLLOW_MAX_M = 700;
const FOLLOW_BACK_M = 60;
const FOLLOW_LEAVE_M = 20;
const FOLLOW_GROW_M = 12;
const FOLLOW_STEP_M = 20;
/**
 * A lane's arrows: those painted in its last ARROW_BACK_M before the stop line (on the link before it too, where
 * that link leads only into this lane), within ARROW_OFF_M of its middle. The one nearest the stop line is the
 * lane's: one 64 m back is often from before a pocket opened (직진 there, 우회전 at the line).
 */
const ARROW_BACK_M = 60;
const ARROW_OFF_M = 1.6;
/** A link through the junction that stops (no link after it, or a loop cut off) this soon, bent this much, turns. */
const SHORT_TURN_M = 60;
const SHORT_TURN_DEG = 10;
/** A way on that comes back past this after turning right (a P-turn), or round past it turning right (a cloverleaf): a loop, not a U-turn. */
const LOOP_DEG = 140;
/** The stop-line lanes' own heading in, over their last this many metres. */
const LANE_IN_M = 20;
/** Where no lane reads as going the guide's way, the lane whose way on keeps nearest the route, if within this. */
const NEAREST_OFF_M = 10;

/** The nearest point of [line] to [p], how far it is, and the line's bearing there. */
function nearestOn(p: LonLat, line: LonLat[]): { at: LonLat; off: number; bearing: number; seg: number } | null {
  let best: { at: LonLat; off: number; bearing: number; seg: number } | null = null;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = toXY(line[i], p), [bx, by] = toXY(line[i + 1], p);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (!best || off < best.off) {
      best = { at: [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t], off, bearing: bearingOf(line[i], line[i + 1]), seg: i };
    }
  }
  return best;
}

export class LaneIndex {
  private db: DatabaseSync | null = null;
  /** Prepared once for each opening of the database; gone with it. */
  private stmts: Statements | null = null;
  private building = false;

  /** [arrows]: the painted arrows (arrows.ts), read first for where each lane goes; without them, the links alone. */
  constructor(private linksFile: string, private dbFile: string, private log: (msg: string) => void = () => {}, private arrows: ArrowIndex | null = null) {}

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
    let db: DatabaseSync | null = null;
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
      db = new DatabaseSync(tmp);
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
      db = null;
      this.stmts = null;
      this.db?.close();
      this.db = null;
      renameSync(tmp, this.dbFile);
      this.log(`lanes: index built, ${n} links`);
    } finally {
      // A build that threw (the disk full, the stream cut) leaves no open handle on the half-written file.
      try { db?.close(); } catch { /* already closed */ }
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
   * The links on from [link]: those its end node starts, or, at a seam between two surveys (none start there), those
   * that start within SEAM_M of its end, running the same way.
   */
  private nextOf(db: Statements, link: { id: string | null; b: string | null; coords: string }, path?: LonLat[]): Link[] {
    if (link.b) {
      const on = db.next.all(link.b) as unknown as Link[];
      if (on.length) return on;
    }
    const p = path ?? (JSON.parse(link.coords) as LonLat[]);
    if (p.length < 2) return [];
    const end = p[p.length - 1];
    let i = p.length - 2;
    while (i > 0 && dist(p[i], end) < 3) i--;
    const way = bearingOf(p[i], end);
    const d = SEAM_M / M, k = d / Math.cos((end[1] * Math.PI) / 180);
    return (db.near.all(end[0] + k, end[0] - k, end[1] + d, end[1] - d) as unknown as Link[]).filter((l) => {
      if (l.id === link.id) return false;
      const q = JSON.parse(l.coords) as LonLat[];
      if (q.length < 2 || dist(q[0], end) > SEAM_M) return false;
      let j = 1;
      while (j < q.length - 1 && dist(q[0], q[j]) < 3) j++;
      return Math.abs(diff(way, bearingOf(q[0], q[j]))) <= SEAM_DEG;
    });
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
      for (const s of this.nextOf(db, seed, seed.path)) {
        // Through the junction and on, each hop the link that stays nearest the route.
        let trail = JSON.parse(s.coords) as LonLat[];
        let last: Link = s;
        for (let hop = 0; hop < 6 && lengthOf(trail) < THREAD_M; hop++) {
          const on = this.nextOf(db, last);
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
   * The same corner found the other way, where thread() finds none: from
   * the lanes under the route before the junction ([before], up to the
   * guide, a point every few metres), every way on through the lane links,
   * the one that keeps closest to the route through and past the turn.
   * This finds a 도류화 right turn — a slip lane that leaves its road
   * before the stop line, at an angle thread()'s lane ends never have —
   * and a turn into the outer lane of a wide road, which stays 8 m from the
   * provider's centreline where thread() wants 6 on average.
   */
  threadAlong(before: LonLat[], after: LonLat[]): LonLat[] | null {
    const db = this.open();
    if (!db || before.length < 2 || after.length < 2) return null;
    const ref = resample([...before, ...after.slice(1)], ALONG_STEP_M);
    const guideM = lengthOf(before);
    const refM = lengthOf(ref);
    const alongOf = (p: LonLat) => projectAlong(p, ref);
    // Lanes under the route a little before the junction, running its way: 70 m back, or nearer where the map starts later.
    let seeds: { link: Link; path: LonLat[]; from: LonLat; i: number }[] = [];
    for (const backM of [70, 40, 20, 0]) {
      const at = along(ref, Math.max(0, guideM - backM)), ahead = along(ref, Math.max(0, guideM - backM) + 10);
      const way = bearingOf(at, ahead);
      const d = SEED_M / M, k = d / Math.cos((at[1] * Math.PI) / 180);
      const found = (db.near.all(at[0] + k, at[0] - k, at[1] + d, at[1] - d) as unknown as Link[]).flatMap((l) => {
        const path = JSON.parse(l.coords) as LonLat[];
        const hit = nearestIndex(at, path);
        if (!hit || hit.off > SEED_M || Math.abs(diff(way, bearingOf(path[hit.i], path[Math.min(path.length - 1, hit.i + 1)]))) > SEED_DEG) return [];
        return [{ link: l, path, from: hit.at, i: hit.i }];
      });
      if (found.length === 0) continue;
      const newest = Math.max(...found.map((f) => surveyYear(f.link.id)));
      seeds = found.filter((f) => surveyYear(f.link.id) === newest);
      break;
    }
    const fits: { trail: LonLat[]; off: number }[] = [];
    let tried = 0;
    const inSpan = (p: LonLat) => alongOf(p) < refM - 10;
    // [mapEnds]: the links stop there (the street turned into is not on 정밀도로지도: 녹천초교's, 월계역's): the turn
    // itself is still the lanes', if it is done and the trail goes on the route's way.
    const judge = (whole: LonLat[], mapEnds = false) => {
      const pts = resample(whole, ALONG_STEP_M);
      const cut = pts.findIndex((p) => alongOf(p) >= guideM + ALONG_PAST_M);
      const trail = cut > 1 ? pts.slice(0, cut + 1) : pts;
      const end = trail[trail.length - 1];
      if (alongOf(end) < guideM + (mapEnds ? ALONG_MAP_ENDS_M : 50)) return;
      const offs = trail.map((p) => offLine(p, ref));
      const mean = offs.reduce((a, b) => a + b, 0) / offs.length;
      // Running the route's way at its end, never far from it, and on the whole beside it.
      const endWay = bearingOf(trail[Math.max(0, trail.length - 3)], end);
      const refWay = bearingOf(along(ref, Math.max(0, alongOf(end) - 5)), along(ref, Math.min(refM, alongOf(end) + 5)));
      if (Math.abs(diff(endWay, refWay)) > 20 || mean > ALONG_MEAN_M || Math.max(...offs) > ALONG_MAX_M || offs[offs.length - 1] > ALONG_END_M) return;
      fits.push({ trail, off: mean });
    };
    const walk = (trail: LonLat[], from: Link, hops: number) => {
      if (++tried > ALONG_TRIES) return;
      if (hops >= 9 || alongOf(trail[trail.length - 1]) >= guideM + ALONG_PAST_M - 10) { judge(trail); return; }
      const on = this.nextOf(db, from);
      if (on.length === 0) { judge(trail, true); return; }
      for (const l of on) {
        const path = JSON.parse(l.coords) as LonLat[];
        // A way that strays from the route, within the stretch the route covers, is not the turn's.
        if (resample(path, 10).some((p) => inSpan(p) && offLine(p, ref) > ALONG_STRAY_M)) continue;
        walk(trail.concat(path.slice(dist(trail[trail.length - 1], path[0]) < TRAIL_JOIN_M ? 1 : 0)), l, hops + 1);
      }
    };
    for (const s of seeds) walk([s.from, ...s.path.slice(s.i + 1)], s.link, 0);
    if (fits.length === 0) return null;
    // The way nearest the route; turning right, a slip lane before it.
    fits.sort((a, b) => a.off - b.off);
    const corner = before[before.length - 1];
    if (turnsRight(bearingOf(before[Math.max(0, before.length - 4)], corner), corner, after)) {
      const near = cornerGap(fits[0].trail, corner);
      const slip = fits.find((f) => cornerGap(f.trail, corner) >= near + SLIP_EXTRA_M);
      if (slip) return slip.trail;
    }
    return fits[0].trail;
  }

  /**
   * Where the travel-direction lanes are at each of [points] (a route's
   * vertices, each with the route's heading there): the middle of the
   * lanes running the same way within SNAP_M, as a point — null where
   * there are none (no 정밀도로지도 here, or only the other way's lanes).
   * The route's line is moved onto it: on a road drawn with both ways'
   * lanes, the line then runs on the side the car is on.
   */
  /**
   * How many lanes the carriageway nearest [at] has (the nearest lane and its neighbours by l, r), or null where the
   * map has no lane within [reachM]: a 보호구역's street read as a lane or two, or as a wide road.
   */
  laneCount(at: LonLat, reachM = 25): number | null {
    const db = this.open();
    if (!db) return null;
    const d = reachM / M, k = d / Math.cos((at[1] * Math.PI) / 180);
    const near = db.near.all(at[0] + k, at[0] - k, at[1] + d, at[1] - d) as unknown as Link[];
    let best: { l: Link; off: number } | null = null;
    for (const l of near) {
      const hit = nearestOn(at, JSON.parse(l.coords) as LonLat[]);
      if (hit && hit.off <= reachM && (!best || hit.off < best.off)) best = { l, off: hit.off };
    }
    if (!best) return null;
    let n = 1;
    for (let id = best.l.l, guard = 0; id && guard < 12; guard++, n++) id = this.byId(db, id)?.l ?? null;
    for (let id = best.l.r, guard = 0; id && guard < 12; guard++, n++) id = this.byId(db, id)?.r ?? null;
    return n;
  }

  snap(points: LonLat[], headings: number[], biases?: number[]): (LonLat | null)[] {
    const db = this.open();
    if (!db) return points.map(() => null);
    // A link's line parsed once a call: neighbouring vertices see the same links, and the parse is most of the cost.
    const lines = new Map<number, LonLat[]>();
    const lineOf = (l: Link) => { let v = lines.get(l.rowid); if (!v) { v = JSON.parse(l.coords) as LonLat[]; lines.set(l.rowid, v); } return v; };
    const alongOf: number[] = [0];
    for (let i = 1; i < points.length; i++) alongOf.push(alongOf[i - 1] + dist(points[i - 1], points[i]));
    return points.map((p, i) => {
      const heading = headings[i];
      if (!Number.isFinite(heading)) return null;
      const d = SNAP_M / M, k = d / Math.cos((p[1] * Math.PI) / 180);
      const near = db.near.all(p[0] + k, p[0] - k, p[1] + d, p[1] - d) as unknown as Link[];
      const found: Found[] = [];
      for (const l of near) {
        const hit = nearestOn(p, lineOf(l));
        if (!hit || hit.off > SNAP_M || Math.abs(diff(heading, hit.bearing)) > SNAP_DEG) continue;
        found.push({ at: hit.at, off: hit.off, year: surveyYear(l.id), id: l.id, l: l.l, r: l.r, link: l, seg: hit.seg });
      }
      if (found.length === 0) return null;
      // One survey where several overlap; then the carriageway the line is on: the nearest lane and the lanes beside it
      // by the map's own neighbours (l, r) — not every lane within a road's width. An exit ramp just parted from the
      // motorway is a road of its own: taken with the motorway's lanes 5–12 m off, the middle of them was a motorway
      // lane, and the line went back onto the motorway and turned off it again further on (동부간선 → 하계역, 2026-10-04).
      // Only the lanes that are the route's (FOLLOW_M): not one about to leave it, nor one that has just come alongside.
      // Before a survey is chosen: a loop ramp joining from a newer survey (2024's, the motorway beside it 2023's) was
      // the only lane left by "the newest", and the line crossed onto it (구리IC, 2026-10-13). Near a turn a lane is
      // followed to the end of the stretch held to the turn's side: it must reach the turn.
      let route = found;
      if (found.length > 1) {
        const bias0 = biases?.[i] ?? 0;
        let ahead = FOLLOW_M;
        if (bias0 !== 0 && biases) {
          let j = i;
          while (j + 1 < points.length && Math.sign(biases[j + 1] ?? 0) === Math.sign(bias0) && alongOf[j + 1] - alongOf[i] <= FOLLOW_MAX_M) j++;
          ahead = Math.min(FOLLOW_MAX_M, Math.max(FOLLOW_M, alongOf[j] - alongOf[i] + FOLLOW_STEP_M));
        }
        const theirs = found.filter((f) => !this.leaves(db, f, points, alongOf, i, ahead, lineOf));
        if (theirs.length) route = theirs;
      }
      const newest = Math.max(...route.map((f) => f.year));
      const ours = route.filter((f) => f.year === newest);
      const nearest = ours.reduce((a, b) => (b.off < a.off ? b : a));
      const byId = new Map(ours.filter((f) => f.id).map((f) => [f.id!, f]));
      let row = [nearest];
      if (nearest.id && (nearest.l || nearest.r)) {
        for (let at = nearest, guard = 0; at.l && byId.has(at.l) && guard < 12; guard++) { at = byId.get(at.l)!; row.unshift(at); }
        for (let at = nearest, guard = 0; at.r && byId.has(at.r) && guard < 12; guard++) { at = byId.get(at.r)!; row.push(at); }
      } else if (!nearest.id) {
        const least = nearest.off;
        row = ours.filter((f) => f.off <= least + CARRIAGEWAY_M);
      }
      if (row.length === 1) return row[0].at;

      // Left to right across the way the road runs.
      const hRad = (heading * Math.PI) / 180;
      const cosH = Math.cos(hRad), sinH = Math.sin(hRad);
      const withSide = row.map((f) => {
        const [x, y] = toXY(f.at, p);
        return { at: f.at, lateral: x * cosH - y * sinH };
      }).sort((a, b) => a.lateral - b.lateral);

      // One lane, the one that serves the way on, never between two (a 4-lane road's middle was drawn on the line
      // between 2차로 and 3차로): into a turn, the lane on its side; else a through lane, left of the middle — not
      // the outermost, where the buses and the right turns are, nor the innermost, where the left turns are.
      // Two lanes have no middle, and left of it was 1차로: the left-turn pocket in town, the overtaking lane on a
      // motorway (지정차로: 편도 2차로 고속도로, 1차로 앞지르기), and a right turn drawn from there crossed both
      // lanes once the bias began. With no turn ahead the line keeps right: 2차로.
      const bias = biases?.[i] ?? 0;
      const n = withSide.length;
      const index = bias <= -0.34 ? 0 : bias >= 0.34 ? n - 1 : n === 2 ? 1 : Math.floor((n - 1) / 2);
      return withSide[index].at;
    });
  }

  /**
   * Whether the lane [f] leaves the road of the route [points] (FOLLOW_LEAVE_M, FOLLOW_GROW_M) followed on for [aheadM]
   * from point [i] (its own link, then at each end the link on that keeps nearest the route) or back along its own
   * link for FOLLOW_BACK_M.
   */
  private leaves(db: Statements, f: Found, points: LonLat[], alongOf: number[], i: number, aheadM: number, lineOf: (l: Link) => LonLat[]): boolean {
    const limit = Math.max(FOLLOW_LEAVE_M, f.off + FOLLOW_GROW_M);
    // The route around here, as the lane is measured against it: to the first vertex at or past each end (a motorway's
    // vertices can be hundreds of metres apart, and a window cut short of the next one left the lane nothing beside it).
    let lo = i, hi = i;
    while (lo > 0 && alongOf[i] - alongOf[lo] < FOLLOW_BACK_M + 30) lo--;
    while (hi + 1 < points.length && alongOf[hi] - alongOf[i] < aheadM + 60) hi++;
    if (hi === lo) return false;
    const route = points.slice(lo, hi + 1);
    const line = lineOf(f.link);
    // On: the rest of its link, then the links after it.
    const trail: LonLat[] = [f.at, ...line.slice(f.seg + 1)];
    let walked = 0;
    for (let k = 1; k < trail.length; k++) walked += dist(trail[k - 1], trail[k]);
    let link: Link = f.link;
    for (let guard = 0; walked < aheadM && guard < 30; guard++) {
      const on = this.nextOf(db, link, lineOf(link));
      if (!on.length) break;
      // The way on nearest the route a little in.
      let best: { l: Link; off: number } | null = null;
      for (const n of on) {
        const q = lineOf(n);
        let len = 0;
        for (let k = 1; k < q.length; k++) len += dist(q[k - 1], q[k]);
        const off = offLine(along(q, Math.min(30, len)), route);
        if (!best || off < best.off) best = { l: n, off };
      }
      const q = lineOf(best!.l);
      for (let k = 1; k < q.length; k++) { trail.push(q[k]); walked += dist(q[k - 1], q[k]); }
      link = best!.l;
    }
    // Only as far as the route goes (its end, or the end of the points asked): past it every lane is "off".
    const routeAhead = alongOf[points.length - 1] - alongOf[i], routeBack = alongOf[i];
    for (let s = FOLLOW_STEP_M; s <= Math.min(aheadM, walked, routeAhead); s += FOLLOW_STEP_M) {
      if (offLine(along(trail, s), route) > limit) return true;
    }
    // Back: its own link before here (where it came from, as far as the link goes).
    const back: LonLat[] = [f.at, ...line.slice(0, f.seg + 1).reverse()];
    let backLen = 0;
    for (let k = 1; k < back.length; k++) backLen += dist(back[k - 1], back[k]);
    for (let s = FOLLOW_STEP_M; s <= Math.min(FOLLOW_BACK_M, backLen, routeBack); s += FOLLOW_STEP_M) {
      if (offLine(along(back, s), route) > limit) return true;
    }
    return false;
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
      const paths = row.map((lane) => JSON.parse(lane.coords) as LonLat[]);
      // The way in as the lanes come to their stop line, not the route's line: the provider's line, 30 m back
      // to the guide, came in 11° off at 창동교 (2026-10-11), and its right-turn lane's 35° read as straight on.
      // Of the lanes that come in the seed's way (a pocket's last metres can curve off it).
      const seedIn = headingIn(paths[row.indexOf(seed)], LANE_IN_M);
      const laneIn = meanDeg(paths.map((p) => headingIn(p, LANE_IN_M)).filter((d) => Math.abs(diff(seedIn, d)) <= 35)) ?? inDeg;
      const shapedRow = row.map((lane, i) => {
        const path = paths[i];
        const end = path[path.length - 1];
        const shaped = new Set<Turn>();
        /** How far this lane's way on stays from the route (its nearest link through), and how much it pulls away: 120 m on against 30 m. */
        let off = Infinity, grows = Infinity;
        for (const s of (lane.b ? (next.all(lane.b) as unknown as Link[]) : [])) {
          const { trail, stopped } = this.wayOn(db, s, laneIn);
          shaped.add(turnOfTrail(laneIn, end, trail, stopped));
          if (after.length >= 2) {
            const probes = [30, 60, 90, 120].filter((m) => m <= lengthOf(trail)).map((m) => offLine(along(trail, m), after));
            if (probes.length) {
              off = Math.min(off, probes.reduce((a, d) => a + d, 0) / probes.length);
              grows = Math.min(grows, probes[probes.length - 1] - probes[0]);
            }
          }
        }
        return { lane, path, shaped: order([...shaped]), off, grows };
      });
      // What is painted on the lane first; where nothing is, where its links go. Only at a junction: where every
      // lane's links run straight on (a lane parting, 50 m before the stop line) the paint is the stop line's ahead.
      const atJunction = shapedRow.some((o) => o.shaped.length === 0 || o.shaped.some((t) => t !== "straight"));
      const paint = shapedRow.map((l) => (atJunction ? this.arrowTurns(db, l.lane, l.path) : null));
      // Paint out of order across the road is the map's slip, not the road's: a 좌회전 arrow (or 직진·좌회전) on
      // the outermost lane, right of a lane painted without a left (국도 43 at 38.1360 and 38.0537, 2026-10-11), is
      // read by the lane's links instead; and the other way round, a right without a left on the innermost. Only
      // the outermost: beside a 중앙버스전용차로, painted 직진, the left-turn lane is right of it.
      const lefty = (t: Turn[]) => t.includes("left") || t.includes("uturn");
      const n = paint.length;
      const outOfOrder = paint.map((t, i) => !!t && (
        (i === n - 1 && lefty(t) && !t.includes("right") && paint.slice(0, i).some((o) => !!o && !lefty(o)))
        || (i === 0 && t.includes("right") && !lefty(t) && paint.slice(1).some((o) => !!o && !o.includes("right")))));
      const read = shapedRow.map((l, i) => {
        const painted = outOfOrder[i] ? null : paint[i];
        // A U-turn is signed, not painted: the innermost lane's link round keeps it beside the paint (a pocket
        // painted 좌회전 into a side road the map does not have, its only link the U-turn).
        const turns = painted ? order(i === 0 && l.shaped.includes("uturn") && !painted.includes("uturn") ? [...painted, "uturn"] : [...painted]) : l.shaped;
        return { turns, painted: !!painted, off: l.off, grows: l.grows };
      });
      // The lanes to be in: those going the route's way after the junction; where every lane goes
      // that way (a motorway fork, a straight road), the ones whose way on stays nearest the route.
      const told = way ?? routeTurn(laneIn, after, seed.before);
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
      return { lanes, fits: told ? read.some((l) => l.turns.includes(told)) : parts, offs: read.map((l) => l.off), painted: read.map((l) => l.painted) };
    };
    // Stop lines nearest the guide first; the one where the lanes part (a turn, or the route taking
    // only some of them) is the junction meant — a stretch where every lane goes straight on is not.
    const seen = new Set<string>();
    let fitting: { lanes: LaneInfo["lanes"]; seed: End } | null = null;
    /** The nearest stop line whose lanes could be read, kept for when none can take the guide's way. */
    let nearest: { lanes: LaneInfo["lanes"]; offs: number[]; painted: boolean[]; seed: End } | null = null;
    for (const seed of ends.sort((a, b) => Math.abs(a.before) + Math.abs(a.side) * 1.5 - (Math.abs(b.before) + Math.abs(b.side) * 1.5))) {
      const key = `${Math.round(seed.before / 8)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { lanes, fits, offs, painted } = readRow(seed);
      if (lanes.length < 2 || lanes.some((l) => l.turns.length === 0)) continue;
      if (!fits) { nearest ??= { lanes, offs, painted, seed }; continue; }
      fitting ??= { lanes, seed };
      const parts = lanes.some((l) => l.turns.some((t) => t !== "straight")) || (lanes.some((l) => l.best) && lanes.some((l) => !l.best));
      if (parts) return { lanes, stopM: Math.round(seed.before), stop: seed.end };
    }
    if (fitting && fitting.lanes.some((l) => l.best) && !fitting.lanes.every((l) => l.best)) {
      const { lanes, seed } = fitting;
      return { lanes, stopM: Math.round(seed.before), stop: seed.end };
    }
    // The guide told a way no lane here reads as taking by its links (a 도류화 left that bends 10° in the first
    // 40 m and 58° by 150 m, 별내 2026-10-11): the lane whose way on keeps nearest the route is the one, and goes
    // the route's way — its links follow the route there. Only for a guide's own way, only where that lane's way
    // on keeps within NEAREST_OFF_M of the route, and never against the paint (a lane painted another way at the
    // nearest stop line: the stop line is another road's); else nothing, which is better than a wrong lane.
    if (!fitting && way && nearest) {
      const least = Math.min(...nearest.offs);
      const { lanes, offs, painted, seed } = nearest;
      const chosen = offs.map((o) => o <= least + 0.5);
      if (least <= NEAREST_OFF_M && !chosen.some((c, i) => c && painted[i])) {
        return {
          lanes: lanes.map((l, i) => (chosen[i] ? { turns: order([...l.turns, way]), best: true } : { turns: l.turns, best: false })),
          stopM: Math.round(seed.before),
          stop: seed.end,
        };
      }
    }
    return null;
  }

  /**
   * The way on from a stop line through link [s]: the links after it to 150 m, each hop the one heading on
   * nearest the way it goes. [stopped] where the links end (no link after: a side road the map does not
   * have) or come round into a loop, which is cut off: a link that heads back more than LOOP_DEG from the way
   * in after the way has turned right — a right-turn lane into a P-turn (right, then 240° round to the left)
   * read -34° at 40 m and -171° at the end, 좌회전 and 유턴 for a lane painted 우회전 (2026-10-11, 국도 43).
   * A U-turn drawn as two links (7 m on, then round to the left) goes on round.
   */
  private wayOn(db: Statements, s: Link, laneIn: number): { trail: LonLat[]; stopped: boolean } {
    let trail = JSON.parse(s.coords) as LonLat[];
    // The link through the junction a loop itself: the right turn into it is the lane's way.
    if (loopsRight(laneIn, trail)) return { trail: cutAtRight(laneIn, trail), stopped: true };
    let last: Link = s;
    for (let hop = 0; hop < 4 && lengthOf(trail) < 150; hop++) {
      const on = this.nextOf(db, last);
      if (on.length === 0) return { trail, stopped: true };
      const heading = bearingOf(trail[trail.length - 2], trail[trail.length - 1]);
      const pick = on.reduce((a, b) => (Math.abs(diff(heading, firstDeg(a))) <= Math.abs(diff(heading, firstDeg(b))) ? a : b));
      const path = JSON.parse(pick.coords) as LonLat[];
      const longer = trail.concat(path.slice(1));
      const back = Math.abs(diff(laneIn, bearingOf(path[Math.max(0, path.length - 2)], path[path.length - 1]))) > LOOP_DEG;
      if ((back && turned(laneIn, trail) > 30) || loopsRight(laneIn, longer)) return { trail, stopped: true };
      trail = longer;
      last = pick;
    }
    return { trail, stopped: false };
  }

  /**
   * What the arrows painted on [lane] in its last ARROW_BACK_M say, the one nearest the stop line; null
   * where none is (no arrows file, or nothing painted there).
   */
  private arrowTurns(db: Statements, lane: Link, path: LonLat[]): Turn[] | null {
    if (!this.arrows?.ready) return null;
    let line = path;
    if (lengthOf(path) < ARROW_BACK_M) {
      const before = this.before(db, lane, path);
      if (before) line = before.concat(path.slice(dist(before[before.length - 1], path[0]) < TRAIL_JOIN_M ? 1 : 0));
    }
    const total = lengthOf(line);
    // The box about the lane's last ARROW_BACK_M: the point that far back and every vertex after it.
    const pts: LonLat[] = [along(line, Math.max(0, total - ARROW_BACK_M))];
    for (let i = line.length - 1, left = total; i >= 0 && left >= total - ARROW_BACK_M; left -= i > 0 ? dist(line[i - 1], line[i]) : 0, i--) pts.push(line[i]);
    const pad = 4 / M, padX = pad / Math.cos((path[0][1] * Math.PI) / 180);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    let best: { turns: Turn[]; back: number; off: number } | null = null;
    for (const a of this.arrows.within(Math.min(...xs) - padX, Math.min(...ys) - pad, Math.max(...xs) + padX, Math.max(...ys) + pad)) {
      const turns = ARROW_TURNS[a.code];
      if (!turns) continue;
      const off = offLine(a.at, line);
      const back = total - projectAlong(a.at, line);
      if (off > ARROW_OFF_M || back > ARROW_BACK_M || back < -3) continue;
      if (!best || back < best.back - 3 || (Math.abs(back - best.back) <= 3 && off < best.off)) best = { turns, back, off };
    }
    return best ? order([...best.turns]) : null;
  }

  /** The link that leads into [lane] and into nothing else (where a lane parts from another, the paint before is the other's). */
  private before(db: Statements, lane: Link, path: LonLat[]): LonLat[] | null {
    if (!lane.a) return null;
    const p = path[0];
    const d = 3 / M, k = d / Math.cos((p[1] * Math.PI) / 180);
    const into = (db.near.all(p[0] + k, p[0] - k, p[1] + d, p[1] - d) as unknown as Link[]).filter((l) => l.b === lane.a);
    if (into.length === 0) return null;
    const lead = into[0];
    if (into.some((l) => l.coords !== lead.coords)) return null;
    if ((db.next.all(lane.a) as unknown as Link[]).length !== 1) return null;
    return JSON.parse(lead.coords) as LonLat[];
  }
}

/**
 * Where a lane's way on through the junction goes, from its end at the stop line [end] heading [inDeg]:
 * by the heading to its point 40 m on (or its end); and where the links stop short of 60 m — into a side road
 * the map does not have — bent 10° or more that way, a turn: the right-turn lanes of 국도 43 end 16–43 m on
 * at 13–28°, and read as straight on at ±30°.
 */
export function turnOfTrail(inDeg: number, end: LonLat, trail: LonLat[], stopped: boolean): Turn {
  const total = lengthOf(trail);
  const t = turnOf(inDeg, bearingOf(end, along(trail, Math.min(40, total))));
  if (t !== "straight" || !stopped || total > SHORT_TURN_M) return t;
  const bend = diff(inDeg, bearingOf(end, trail[trail.length - 1]));
  return bend >= SHORT_TURN_DEG ? "right" : bend <= -SHORT_TURN_DEG ? "left" : "straight";
}

/** The heading of [path]'s last [m] metres (from the point that far back to its end). */
function headingIn(path: LonLat[], m: number): number {
  const total = lengthOf(path);
  return bearingOf(along(path, Math.max(0, total - m)), path[path.length - 1]);
}

/** The mean of headings, as directions (350° and 10° make 0°); null for none. */
function meanDeg(degs: number[]): number | null {
  if (degs.length === 0) return null;
  const x = degs.reduce((s, d) => s + Math.sin((d * Math.PI) / 180), 0), y = degs.reduce((s, d) => s + Math.cos((d * Math.PI) / 180), 0);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

/** How far [path] turns from [inDeg] by its end, summed bend by bend (right +, left −): a full loop is ±360, not 0. */
function turned(inDeg: number, path: LonLat[]): number {
  let heading = inDeg, sum = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    if (dist(path[i], path[i + 1]) < 0.5) continue;
    const b = bearingOf(path[i], path[i + 1]);
    sum += diff(heading, b);
    heading = b;
  }
  return sum;
}

/** Whether [path] comes round past LOOP_DEG by turning right: a loop, never a U-turn (those turn left). */
function loopsRight(inDeg: number, path: LonLat[]): boolean {
  return turned(inDeg, path) > LOOP_DEG;
}

/** [path] up to where it has turned right by 90°: the loop's first part, the right turn into it. */
function cutAtRight(inDeg: number, path: LonLat[]): LonLat[] {
  for (let i = 2; i <= path.length; i++) if (turned(inDeg, path.slice(0, i)) > 90) return path.slice(0, i);
  return path;
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
    // Only where it matters: some lane at the stop line cannot go the route's way — and some can (a stop line
    // where none reads as going it is told by the lane nearest the route, for a guide; not a warning).
    if (info.lanes.every((l) => l.turns.includes(way)) || !info.lanes.some((l) => l.turns.includes(way))) continue;
    out.push({ ...(info as LaneInfo & { stop: LonLat }), way });
  }
  return out;
}

/** [path] as points every [step] metres, its own ends kept. */
function resample(path: LonLat[], step: number): LonLat[] {
  if (path.length < 2) return path.slice();
  const total = lengthOf(path);
  const out: LonLat[] = [];
  for (let m = 0; m < total; m += step) out.push(along(path, m));
  out.push(path[path.length - 1]);
  return out;
}
/** How far along [line] the point of it nearest [p] is, metres. */
function projectAlong(p: LonLat, line: LonLat[]): number {
  let best = Infinity, at = 0, walked = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = toXY(line[i], p), [bx, by] = toXY(line[i + 1], p);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    const seg = Math.sqrt(len2);
    if (off < best) { best = off; at = walked + t * seg; }
    walked += seg;
  }
  return at;
}
/** The vertex index of [line] whose segment comes nearest [p], with the nearest point and its distance. */
function nearestIndex(p: LonLat, line: LonLat[]): { i: number; at: LonLat; off: number } | null {
  let best: { i: number; at: LonLat; off: number } | null = null;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = toXY(line[i], p), [bx, by] = toXY(line[i + 1], p);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (!best || off < best.off) best = { i, off, at: [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t] };
  }
  return best;
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
