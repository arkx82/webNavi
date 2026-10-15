import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * 정밀도로지도's speed signs (tools/hdmap/build.py → WORK_DIR/hdmap/signs.geojsons): the limit posted by the road,
 * where the sign stands and the lane link it is for. Put on a route, a sign's limit is the road's from the sign on —
 * before TMAP's or 표준노드링크's word for it (road/limits.ts), which can be a road's old limit or another road's.
 *
 * Only 최고속도제한 signs: not 안전속도 (an auxiliary plate under road works), 최저속도, 서행 and the like. A sign is the
 * route's where it stands by the route and its lane link runs the route's way beside it — not the other carriageway's,
 * nor a side road's.
 */
export type LonLat = [number, number];
export interface SpeedSign { at: LonLat; kmh: number; link: string | null }
/** A sign put on a path: [m] metres along it. */
export interface PostedAt { m: number; kmh: number }

/** A sign this near the route's line stands by it (a sign is at the road's edge, the line in a lane). */
const SIGN_ROUTE_M = 25;
/** Its lane link this near the route where the sign is, and running within this of the route's way. */
const LINK_ROUTE_M = 12;
const LINK_DEG = 35;
/** Signs this close along the route (both sides, a gantry over the lanes) are one. */
const SAME_SIGN_M = 40;
/** A twin is another sign: this far along from it at least (both sides of a road stand a few metres apart along it too). */
const TWIN_APART_M = 2;
/** The grid the signs are kept in, degrees. */
const CELL = 0.005;

const M = 111_320;
const toXY = (p: LonLat, o: LonLat): [number, number] => [(p[0] - o[0]) * M * Math.cos((o[1] * Math.PI) / 180), (p[1] - o[1]) * M];
const dist = (a: LonLat, b: LonLat) => Math.hypot(...toXY(a, b));
const bearingOf = (a: LonLat, b: LonLat) => { const [x, y] = toXY(b, a); return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360; };
const diff = (a: number, b: number) => Math.abs(((b - a + 540) % 360) - 180);

/**
 * The posted limit a sign's words say, as the surveys wrote them: "최고속도제한 50km", "최고속도60제한", "최고속도 60",
 * "60/최고속도", "속도제한50", "최고속도제한(50km)", "최고속도제한_50", "최고속도제한 30k". Null for any other sign —
 * 최저속도, 안전속도 (a plate under road works), 속도를 줄이시오 — and where the number is cut short ("최고속도제한5":
 * 50 or 5, not to be guessed) or there is more than one.
 */
export function kmhOf(remark: unknown): number | null {
  const r = String(remark ?? "").replace(/\s+/g, "");
  if (!/최고속도|속도제한/.test(r) || /최저|안전속도|줄이/.test(r)) return null;
  const vs = [...new Set((r.match(/\d+/g) ?? []).map(Number))];
  if (vs.length !== 1) return null;
  const v = vs[0];
  return v >= 20 && v <= 130 && v % 10 === 0 ? v : null;
}

/** The point on segment [a, b] nearest [p]: how far off, and the share of the way along. */
function onSegment(p: LonLat, a: LonLat, b: LonLat): { off: number; t: number } {
  const [ax, ay] = toXY(a, p), [bx, by] = toXY(b, p);
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return { off: Math.hypot(ax + t * dx, ay + t * dy), t };
}

/** The point of [line] nearest [p]: how far off, and the way the line runs there. */
function nearestOnLine(p: LonLat, line: LonLat[]): { off: number; deg: number } | null {
  let best: { off: number; deg: number } | null = null;
  for (let i = 0; i + 1 < line.length; i++) {
    const { off } = onSegment(p, line[i], line[i + 1]);
    if (!best || off < best.off) best = { off, deg: bearingOf(line[i], line[i + 1]) };
  }
  return best;
}

export class SpeedSigns {
  private grid = new Map<string, SpeedSign[]>();
  private loadedAt = 0;
  private loading = false;
  private count = 0;

  /**
   * [lineOf]: a lane link's line by its ID (the lane index, hdmap.ts), for the way a sign's lane runs; [carriageway]:
   * the lanes of the road the route is on at a point, its way (lanes.ts) — a sign is the route's only if its lane is
   * one of them.
   */
  constructor(
    private file: string,
    private lineOf: (id: string) => LonLat[] | null,
    private log: (m: string) => void = () => {},
    private carriageway: (p: LonLat, deg: number) => Set<string> | null = () => null,
    /** Testing variants: whether a sign needs a twin (FLAGS env in evaluation), the carriageway check. */
    readonly opts: { twin?: boolean; road?: boolean } = { twin: true, road: true },
  ) {}

  get ready() { return this.count > 0; }
  get size() { return this.count; }

  /** Read the file again when it is newer than what is in hand; in the background, once at a time. */
  async refresh(): Promise<void> {
    if (this.loading || !existsSync(this.file)) return;
    const at = statSync(this.file).mtimeMs;
    if (at <= this.loadedAt) return;
    this.loading = true;
    try {
      const grid = new Map<string, SpeedSign[]>();
      let n = 0;
      for await (const line of createInterface({ input: createReadStream(this.file) })) {
        if (!line.trim()) continue;
        let f: { properties?: Record<string, unknown>; geometry?: { coordinates?: unknown } };
        try { f = JSON.parse(line); } catch { continue; }
        const kmh = kmhOf(f.properties?.rem);
        if (kmh == null) continue;
        const c = centre(f.geometry?.coordinates);
        if (!c) continue;
        const link = f.properties?.link ? String(f.properties.link) : null;
        this.put(grid, { at: c, kmh, link });
        n++;
      }
      this.grid = grid;
      this.count = n;
      this.loadedAt = at;
      this.log(`정밀도로지도 속도 표지판 ${n}개`);
    } finally {
      this.loading = false;
    }
  }

  private put(grid: Map<string, SpeedSign[]>, s: SpeedSign) {
    const key = `${Math.floor(s.at[0] / CELL)},${Math.floor(s.at[1] / CELL)}`;
    let cell = grid.get(key);
    if (!cell) grid.set(key, (cell = []));
    cell.push(s);
  }

  /** The signs in the cells about [p]. */
  private near(p: LonLat): SpeedSign[] {
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
    const out: SpeedSign[] = [];
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) out.push(...(this.grid.get(`${x},${y}`) ?? []));
    return out;
  }

  /**
   * The speed signs that are [path]'s, by how far along it each stands: by the route (SIGN_ROUTE_M), the lane it is
   * for beside the route (LINK_ROUTE_M) and running its way (LINK_DEG). Signs of one place (both sides, a gantry) as one.
   */
  along(path: LonLat[]): PostedAt[] {
    if (!this.count || path.length < 2) return [];
    const found: PostedAt[] = [];
    const seen = new Set<SpeedSign>();
    const lines = new Map<string, LonLat[] | null>();
    const lineOf = (id: string) => { if (!lines.has(id)) lines.set(id, this.lineOf(id)); return lines.get(id)!; };
    let m0 = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i], b = path[i + 1];
      const len = dist(a, b);
      const way = bearingOf(a, b);
      // The cells about both ends and the middle: a segment can be long on a motorway.
      const cand = new Set<SpeedSign>();
      for (let k = 0; k <= Math.max(1, Math.ceil(len / (CELL * M * 0.8))); k++) {
        const t = k / Math.max(1, Math.ceil(len / (CELL * M * 0.8)));
        for (const s of this.near([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) cand.add(s);
      }
      for (const s of cand) {
        if (seen.has(s)) continue;
        const hit = onSegment(s.at, a, b);
        if (hit.off > SIGN_ROUTE_M || (hit.t === 0 && i > 0) || (hit.t === 1 && i + 2 < path.length)) continue;
        const line = s.link ? lineOf(s.link) : null;
        if (!line) continue;
        // The lane the sign is for, beside the route where the sign is, and running the route's way.
        const p: LonLat = [a[0] + (b[0] - a[0]) * hit.t, a[1] + (b[1] - a[1]) * hit.t];
        const lane = nearestOnLine(p, line);
        if (!lane || lane.off > LINK_ROUTE_M || diff(lane.deg, way) > LINK_DEG) continue;
        // Its lane one of the road's the route is on: not a ramp's beside it, nor a slip road's.
        if (this.opts.road) {
          const road = this.carriageway(p, way);
          if (road && !road.has(s.link!)) continue;
        }
        seen.add(s);
        found.push({ m: m0 + hit.t * len, kmh: s.kmh });
      }
      m0 += len;
    }
    found.sort((x, y) => x.m - y.m);
    // A posted limit stands on both sides, or over the lanes, or again a little on: one sign alone is often a lane's
    // or a turning pocket's (a 30 in 3차로 among 60s, 2026-10-15) — taken only with a twin of its value within
    // SAME_SIGN_M. The twins as one.
    const one: PostedAt[] = [];
    for (let i = 0; i < found.length; i++) {
      const f = found[i];
      const last = one[one.length - 1];
      if (last && f.m - last.m < SAME_SIGN_M && f.kmh === last.kmh) continue;
      if (this.opts.twin) {
        // Another sign, not the same one written twice (the surveys have some, to the centimetre): a few metres off.
        const twin = found.some((g, j) => j !== i && g.kmh === f.kmh && Math.abs(g.m - f.m) < SAME_SIGN_M && Math.abs(g.m - f.m) >= TWIN_APART_M);
        if (!twin) continue;
      }
      one.push(f);
    }
    return one;
  }
}

/** The middle of a geometry's points, however deep its coordinates go. */
function centre(coords: unknown): LonLat | null {
  let sx = 0, sy = 0, n = 0;
  const walk = (c: unknown) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") { sx += c[0]; sy += c[1]; n++; return; }
    for (const d of c) walk(d);
  };
  walk(coords);
  return n ? [sx / n, sy / n] : null;
}
