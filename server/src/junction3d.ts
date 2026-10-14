import { existsSync, statSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * A junction in three dimensions, for the page's junction view
 * (web/src/junction-view.ts): 정밀도로지도's lane links, lane lines and road
 * markings round a point, with their heights (tools/hdmap/build3d.py →
 * j3d.db), in metres about the point — x east, y up (the survey's
 * ellipsoidal height), z south, as three.js has it — and the route's line
 * through them lifted onto the lanes it drives.
 */
export type LonLat = [number, number];
export type P3 = [number, number, number];
export interface JunctionScene {
  centre: LonLat;
  /** The lanes' middle lines (a road is drawn as their ribbons side by side). */
  links: P3[][];
  /** Lane lines: t is the survey's type (first figure the colour, last 2 for dashed). */
  lines: { t: string; pts: P3[] }[];
  /** Road markings (arrows, words, crossings): an outline each. */
  marks: { k: string; pts: P3[] }[];
  /** The route's points, lifted: null where no lane of its way is under it. */
  route: (P3 | null)[];
  /** How many of the route's points had a lane of its way under them (the rest took their neighbours' heights). */
  matched: number;
}

interface Row { id: number; kind: number; yr: number; t: string; k: string; xyz: string }

const M = 111_320;
/** Of two surveys of one road the older is let go where the newer lies within this of it, for most of its length. */
const SAME_M = 1.5;
/** A route point takes the height of a lane of its way within this. */
const ROUTE_M = 4;
const ROUTE_DEG = 35;
/** A metre of height from the point before weighs as this many metres off. */
const CLIMB_WEIGHT = 2;

export class Junction3D {
  private db: DatabaseSync | null = null;
  private near: StatementSync | null = null;
  private openedAt = 0;

  constructor(private file: string) {}

  private open(): DatabaseSync | null {
    if (!existsSync(this.file)) return null;
    // A rebuilt file is opened again.
    const at = statSync(this.file).mtimeMs;
    if (this.db && at !== this.openedAt) { this.db.close(); this.db = null; }
    if (!this.db) {
      this.db = new DatabaseSync(this.file, { readOnly: true });
      this.near = this.db.prepare("SELECT f.id, f.kind, f.yr, f.t, f.k, f.xyz FROM box b JOIN f ON f.id = b.id WHERE b.minx <= ? AND b.maxx >= ? AND b.miny <= ? AND b.maxy >= ?");
      this.openedAt = at;
    }
    return this.db;
  }

  get ready() {
    return !!this.open();
  }

  /** The junction round [centre] within [radius] metres, and [route] (lon/lat) lifted onto its lanes. */
  scene(centre: LonLat, radius: number, route: LonLat[] = []): JunctionScene | null {
    if (!this.open()) return null;
    const kx = M * Math.cos((centre[1] * Math.PI) / 180);
    const dLat = (radius + 60) / M, dLon = (radius + 60) / kx;
    const rows = this.near!.all(centre[0] + dLon, centre[0] - dLon, centre[1] + dLat, centre[1] - dLat) as unknown as Row[];
    const local = (p: number[]): P3 => [round((p[0] - centre[0]) * kx), round(p[2]), round(-(p[1] - centre[1]) * M)];
    const within = (p: P3) => Math.abs(p[0]) <= radius && Math.abs(p[2]) <= radius;
    const feats = rows.map((r) => ({ ...r, pts: (JSON.parse(r.xyz) as number[][]).map(local) }));
    // A link's points can lie a kilometre apart on a straight: filled in, so its part inside the square is kept.
    for (const f of feats) if (f.kind !== 2) f.pts = fill(f.pts, 10);
    const kept = dropOlder(feats);
    const out: JunctionScene = { centre, links: [], lines: [], marks: [], route: [], matched: 0 };
    for (const f of kept) {
      if (f.kind === 2) {
        if (f.pts.some(within)) out.marks.push({ k: f.k, pts: f.pts });
        continue;
      }
      // Long lines (a motorway's link runs a kilometre and more) are cut to the square, a little past it.
      for (const run of cut(f.pts, radius + 30)) {
        if (f.kind === 0) out.links.push(run);
        else out.lines.push({ t: f.t, pts: run });
      }
    }
    const lifted = lift(route.map((p) => local([p[0], p[1], 0])), out.links);
    out.route = lifted.points;
    out.matched = lifted.matched;
    return out;
  }
}

const round = (v: number) => Math.round(v * 10) / 10;

/** [pts] with points added so none is more than [step] metres from the next. */
function fill(pts: P3[], step: number): P3[] {
  const out: P3[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], n = Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / step);
    for (let k = 1; k < n; k++) out.push([round(a[0] + (k / n) * (b[0] - a[0])), round(a[1] + (k / n) * (b[1] - a[1])), round(a[2] + (k / n) * (b[2] - a[2]))]);
    out.push(b);
  }
  return out;
}

/** [pts]'s stretches inside the square of half-side [half], each of two points or more. */
function cut(pts: P3[], half: number): P3[][] {
  const out: P3[][] = [];
  let run: P3[] = [];
  for (const p of pts) {
    if (Math.abs(p[0]) <= half && Math.abs(p[2]) <= half) run.push(p);
    else { if (run.length > 1) out.push(run); run = []; }
  }
  if (run.length > 1) out.push(run);
  return out;
}

/** The features less those an newer survey of the same kind lies on (two surveys of a road drawn on each other z-fight). */
function dropOlder<T extends { kind: number; yr: number; pts: P3[] }>(feats: T[]): T[] {
  const years = new Set(feats.map((f) => f.yr));
  if (years.size < 2) return feats;
  const grid = new Map<string, { p: P3; yr: number; kind: number }[]>();
  const key = (x: number, z: number) => `${Math.floor(x / 5)}:${Math.floor(z / 5)}`;
  for (const f of feats) for (const p of f.pts) {
    const k = key(p[0], p[2]);
    const l = grid.get(k);
    if (l) l.push({ p, yr: f.yr, kind: f.kind }); else grid.set(k, [{ p, yr: f.yr, kind: f.kind }]);
  }
  return feats.filter((f) => {
    let on = 0;
    for (const p of f.pts) {
      const gx = Math.floor(p[0] / 5), gz = Math.floor(p[2] / 5);
      let hit = false;
      for (let i = -1; i <= 1 && !hit; i++) for (let j = -1; j <= 1 && !hit; j++) {
        for (const q of grid.get(`${gx + i}:${gz + j}`) ?? []) {
          if (q.kind === f.kind && q.yr > f.yr && Math.hypot(p[0] - q.p[0], p[2] - q.p[2]) < SAME_M && Math.abs(p[1] - q.p[1]) < 2) { hit = true; break; }
        }
      }
      if (hit) on++;
    }
    return on < 0.6 * f.pts.length;
  });
}

const headingOf = (a: P3, b: P3) => ((Math.atan2(b[0] - a[0], -(b[2] - a[2])) * 180) / Math.PI + 360) % 360;
const turn = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * The route's points given heights: each the height of the lane under it running its way, of the lanes
 * stacked there (a road over a road) the one nearest the height before — a route goes up a ramp, it
 * does not jump from the road below to the bridge. Points with none take their neighbours' between.
 */
export function lift(route: P3[], links: P3[][]): { points: (P3 | null)[]; matched: number } {
  if (!route.length) return { points: [], matched: 0 };
  const segs: { a: P3; b: P3; deg: number }[] = [];
  for (const l of links) for (let i = 1; i < l.length; i++) segs.push({ a: l[i - 1], b: l[i], deg: headingOf(l[i - 1], l[i]) });
  const grid = new Map<string, number[]>();
  const key = (x: number, z: number) => `${Math.floor(x / 20)}:${Math.floor(z / 20)}`;
  segs.forEach((s, n) => {
    const keys = new Set([key(s.a[0], s.a[2]), key(s.b[0], s.b[2]), key((s.a[0] + s.b[0]) / 2, (s.a[2] + s.b[2]) / 2)]);
    for (const k of keys) { const l = grid.get(k); if (l) l.push(n); else grid.set(k, [n]); }
  });
  const out: (P3 | null)[] = [];
  let before: number | null = null;
  for (let i = 0; i < route.length; i++) {
    const p = route[i];
    const way = headingOf(route[Math.max(0, i - 1)], route[Math.min(route.length - 1, i + 1)]);
    const gx = Math.floor(p[0] / 20), gz = Math.floor(p[2] / 20);
    const heights: { h: number; off: number }[] = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const n of grid.get(`${gx + a}:${gz + b}`) ?? []) {
        const s = segs[n];
        if (turn(s.deg, way) > ROUTE_DEG) continue;
        const dx = s.b[0] - s.a[0], dz = s.b[2] - s.a[2], len = dx * dx + dz * dz;
        const t = len ? Math.max(0, Math.min(1, ((p[0] - s.a[0]) * dx + (p[2] - s.a[2]) * dz) / len)) : 0;
        const off = Math.hypot(s.a[0] + t * dx - p[0], s.a[2] + t * dz - p[2]);
        if (off <= ROUTE_M) heights.push({ h: s.a[1] + t * (s.b[1] - s.a[1]), off });
      }
    }
    if (!heights.length) { out.push(null); continue; }
    // Nearest, and nearest the height before: a lane beside on the flat does not hold a route going up its ramp,
    // and a deck 8 m over or under is never the one.
    const cost = (c: { h: number; off: number }) => c.off + (before == null ? 0 : CLIMB_WEIGHT * Math.abs(c.h - before));
    const pick = heights.reduce((x, y) => (cost(y) < cost(x) ? y : x));
    before = pick.h;
    out.push([p[0], round(pick.h), p[2]]);
  }
  const matched = out.filter(Boolean).length;
  // Gaps: the height between the nearest lifted either side.
  for (let i = 0; i < out.length; i++) {
    if (out[i]) continue;
    let a = i - 1; while (a >= 0 && !out[a]) a--;
    let b = i + 1; while (b < out.length && !out[b]) b++;
    const ha = a >= 0 ? out[a]![1] : null, hb = b < out.length ? out[b]![1] : null;
    if (ha == null && hb == null) continue;
    const h = ha == null ? hb! : hb == null ? ha : ha + ((i - a) / (b - a)) * (hb - ha);
    out[i] = [route[i][0], round(h), route[i][2]];
  }
  return { points: out, matched };
}
