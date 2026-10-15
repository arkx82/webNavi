import { existsSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { PostedAt } from "./signs.js";

/**
 * The speed limit of the road, all the way: the round sign at the top of the
 * car's panel (web/src/main.ts) shows it wherever the car is, so it has to be
 * right where it is shown.
 *
 * Measured 2026-10-13 against the 30 speed cameras on 36 routes the car had
 * driven or pretended (each camera's limit is the posted one where it stands):
 * TMAP's road matching agreed with 24, 표준노드링크's MAX_SPD with 18 — it
 * still has 테헤란로 at 60 where 안전속도 5030 made it 50. So TMAP's answer
 * comes first, 표준노드링크's fills where TMAP has none (no key, the day's
 * calls spent, a point TMAP put on another road), and the page puts the
 * route's own speed cameras over both (warnings.ts), and a 보호구역 or a 구간
 * 단속 over all.
 *
 * TMAP's terms: its answers are not kept past 24 hours (TMAP_KEEP_MS), and its
 * Road API is 1,000 calls a day free (TMAP_DAY_BUDGET keeps short of it).
 */

export type LonLat = [number, number];
export type LimitSource = "tmap" | "nodelink" | "sign";
/** A stretch of the route at one limit: [from, to] as path positions (vertex index + the fraction to the next). */
export interface LimitRun {
  from: number;
  to: number;
  kmh: number;
  src: LimitSource;
}
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json: () => Promise<unknown> }>;

/** The route is looked at this often. */
export const STEP_M = 100;
/** Points to a TMAP road-matching call (matchToRoads takes 100). */
const TMAP_PER_CALL = 100;
/** A day's TMAP road calls, short of the free 1,000: past it, 표준노드링크 alone until midnight. */
export const TMAP_DAY_BUDGET = 900;
/** TMAP's answers are let go before a day (its terms: none kept 24 hours). */
const TMAP_KEEP_MS = 23 * 3_600_000;
/** A point TMAP matched further than this from where it was asked is on another road: not taken. */
const MATCH_OFF_M = 25;
/** A remembered TMAP answer is this road's if it is this near and runs this nearly the same way (either way along). */
const REUSE_M = 12;
const REUSE_DEG = 30;
/** Off a route, TMAP's nearest road is asked at most this often a car; between, what it said or 표준노드링크. */
const HERE_EVERY_MS = 10_000;
/** What TMAP last said holds while the car goes on its way: this long, this far, this little turned. */
const HOLD_MS = 30_000;
const HOLD_M = 500;
const HOLD_DEG = 30;
/** OSRM's waypoints on the route, this many samples apart (500 m), each snapped the route's way. */
const WAYPOINT_EVERY = 5;
/** 표준노드링크's ids for a link's inner vertices begin here (tools/nodelink/build.py VERTEX_BASE). */
const INNER_ID = 9_000_000_000;
/** Limits that are limits: a 0 or a 5 is a blank. */
/**
 * Limits that are a road's posted limit: under 20 is a junction's inner link or a lane into a car park (TMAP gave a
 * 100 m link 10 between two of 50 on 무안's 국도, 2026-10-14), and a 0 or a 5 a blank.
 */
const plausible = (v: unknown): v is number => typeof v === "number" && v >= 20 && v <= 130;
/** A run shorter than this with the same limit either side is a junction's link, not a change of limit: it takes theirs. */
export const BLIP_M = 150;
/**
 * A speed sign's limit holds from the sign on (road/signs.ts) until the next sign, or where the road's own data
 * changes (another road), or this far at most; over a stretch the data has nothing for, this far.
 */
export const SIGN_HOLD_M = 2_000;
export const SIGN_FILL_M = 500;

/**
 * The posted limits [posted] put over the limits each sample has [kmh] (from TMAP and 표준노드링크): from each sign's
 * sample on, the sign's, while the data says the one road (its value as at the sign) — the data's old or wrong value
 * for that road is the sign's to put right — up to the next sign, SIGN_HOLD_M at most (SIGN_FILL_M where the data
 * had none). Returns how many samples a sign set.
 */
export function overlaySigns(samples: Sample[], kmh: (number | null)[], src: (LimitSource | null)[], posted: PostedAt[]): number {
  const data = kmh.slice();
  let set = 0;
  for (let k = 0; k < posted.length; k++) {
    const sign = posted[k], next = posted[k + 1];
    // The first sample whose stretch (from halfway back) the sign stands in or before.
    let j0 = samples.findIndex((s, i) => (i + 1 < samples.length ? (s.m + samples[i + 1].m) / 2 : Infinity) >= sign.m);
    if (j0 < 0) continue;
    const road = data[j0];
    for (let j = j0; j < samples.length; j++) {
      const on = samples[j].m - sign.m;
      if (on > (road == null ? SIGN_FILL_M : SIGN_HOLD_M)) break;
      if (next && samples[j].m >= next.m) break;
      if (j > j0 && data[j] != null && data[j] !== road) break;
      kmh[j] = sign.kmh;
      src[j] = "sign";
      set++;
    }
  }
  return set;
}

const R = 6_371_008.8;
const RAD = Math.PI / 180;
export function metres(a: LonLat, b: LonLat): number {
  const x = (b[0] - a[0]) * RAD * Math.cos(((a[1] + b[1]) / 2) * RAD);
  const y = (b[1] - a[1]) * RAD;
  return Math.hypot(x, y) * R;
}
export function bearing(a: LonLat, b: LonLat): number {
  const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * RAD), y = b[1] - a[1];
  return ((Math.atan2(x, y) / RAD) + 360) % 360;
}
const turn = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
/** The difference of two ways along a road, either direction the same. */
const along = (a: number, b: number) => { const d = turn(a, b); return Math.min(d, 180 - d); };

/** The route every STEP_M: each point, its place on the path, and the way the path runs there. */
export interface Sample {
  p: LonLat;
  at: number;
  deg: number;
  m: number;
}
export function resample(path: LonLat[], step = STEP_M): Sample[] {
  const out: Sample[] = [];
  if (path.length < 2) return out;
  let done = 0, next = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], d = metres(a, b);
    if (d <= 0) continue;
    const deg = bearing(a, b);
    while (next <= done + d) {
      const t = (next - done) / d;
      out.push({ p: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], at: i - 1 + t, deg, m: next });
      next += step;
    }
    done += d;
  }
  const last = path.length - 1;
  if (!out.length || out[out.length - 1].at < last - 1e-6) out.push({ p: path[last], at: last, deg: bearing(path[last - 1], path[last]), m: done });
  return out;
}

/** TMAP's answers by place and way, kept less than a day: a re-route, the way back, a drive off the route ask again for nothing. */
class Remembered {
  private cells = new Map<string, { p: LonLat; deg: number; kmh: number; t: number }[]>();
  private static cell = (p: LonLat) => `${Math.floor(p[0] / 0.0005)}:${Math.floor(p[1] / 0.0004)}`;
  constructor(private now: () => number) {}
  put(p: LonLat, deg: number, kmh: number) {
    const k = Remembered.cell(p);
    const list = (this.cells.get(k) ?? []).filter((e) => this.now() - e.t < TMAP_KEEP_MS && !(metres(e.p, p) < 3 && along(e.deg, deg) < 10));
    list.push({ p, deg, kmh, t: this.now() });
    this.cells.set(k, list);
  }
  near(p: LonLat, deg: number): number | undefined {
    const x = Math.floor(p[0] / 0.0005), y = Math.floor(p[1] / 0.0004);
    let best: { d: number; kmh: number } | undefined;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const e of this.cells.get(`${x + i}:${y + j}`) ?? []) {
        if (this.now() - e.t >= TMAP_KEEP_MS || along(e.deg, deg) > REUSE_DEG) continue;
        const d = metres(e.p, p);
        if (d <= REUSE_M && (!best || d < best.d)) best = { d, kmh: e.kmh };
      }
    }
    return best?.kmh;
  }
  /** Old answers let go (called now and then). */
  sweep() {
    for (const [k, list] of this.cells) {
      const kept = list.filter((e) => this.now() - e.t < TMAP_KEEP_MS);
      if (kept.length) this.cells.set(k, kept); else this.cells.delete(k);
    }
  }
}

/** 표준노드링크's links (links.db): by the nodes at their ends, and by an inner vertex (each link's inner ids run in one block). */
class Links {
  private db: DatabaseSync | null = null;
  private fromStmt: StatementSync | null = null;
  private endsStmt: StatementSync | null = null;
  private blocks: { first: Float64Array; last: Float64Array; kmh: Int16Array } | null = null;
  constructor(private file: string) {}
  private open(): boolean {
    if (this.db) return true;
    if (!existsSync(this.file)) return false;
    this.db = new DatabaseSync(this.file, { readOnly: true });
    this.fromStmt = this.db.prepare("SELECT t, maxspd FROM links WHERE f = ?");
    this.endsStmt = this.db.prepare("SELECT maxspd FROM links WHERE f = ? AND t = ?");
    return true;
  }
  get ready() { return this.open(); }
  from(node: string): { t: string; maxspd: number | null }[] {
    return this.open() ? (this.fromStmt!.all(node) as { t: string; maxspd: number | null }[]) : [];
  }
  /** The limit of the link an inner vertex [n] is on. */
  inner(n: number): number | null {
    if (!this.open() || n < INNER_ID) return null;
    const inner = this.innerIndex();
    let lo = 0, hi = inner.first.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (inner.first[mid] > n) hi = mid - 1;
      else if (inner.last[mid] < n) lo = mid + 1;
      else return inner.kmh[mid] || null;
    }
    return null;
  }
  /** The limit of the link from node [a] to node [b] (its two ends). */
  ends(a: number, b: number): number | null {
    if (!this.open()) return null;
    const r = this.endsStmt!.get(String(a), String(b)) as { maxspd: number | null } | undefined;
    return r?.maxspd ?? null;
  }
  /** Built the first time a car off its route asks: a few seconds over the 1.5 million links. */
  private innerIndex() {
    if (this.blocks) return this.blocks;
    const rows: [number, number, number][] = [];
    for (const r of this.db!.prepare("SELECT nodes, maxspd FROM links").iterate() as Iterable<{ nodes: string; maxspd: number | null }>) {
      const ids = r.nodes.split(",");
      if (ids.length < 3) continue;
      const first = Number(ids[1]), last = Number(ids[ids.length - 2]);
      if (first >= INNER_ID) rows.push([Math.min(first, last), Math.max(first, last), r.maxspd ?? 0]);
    }
    rows.sort((x, y) => x[0] - y[0]);
    this.blocks = { first: Float64Array.from(rows, (r) => r[0]), last: Float64Array.from(rows, (r) => r[1]), kmh: Int16Array.from(rows, (r) => r[2]) };
    return this.blocks;
  }
}

const defaultFetch: Fetch = async (url, init) => {
  const a = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  return { status: a.status, json: () => a.json() };
};

export class SpeedLimits {
  private remembered: Remembered;
  private links: Links;
  private calls = { day: "", n: 0 };
  private lastError: string | null = null;
  private hereAskedAt = new Map<string, number>();
  /** The last TMAP limit each car off its route was given, where and which way. */
  private lastTold = new Map<string, { kmh: number; p: LonLat; deg: number; t: number }>();
  private sweptAt = 0;
  /** 정밀도로지도's speed signs (road/signs.ts), when the HD map is there: useSigns. */
  private signs: { ready: boolean; along: (path: LonLat[]) => PostedAt[] } | null = null;

  constructor(
    private tmapKey: () => string | undefined,
    private osrmUrl: () => string | undefined,
    linksDb: string,
    private log: (m: string) => void = () => {},
    private fetchJson: Fetch = defaultFetch,
    private now: () => number = Date.now,
  ) {
    this.remembered = new Remembered(now);
    this.links = new Links(linksDb);
  }

  /** The posted limits by the road, put over TMAP's and 표준노드링크's along a route. */
  useSigns(signs: { ready: boolean; along: (path: LonLat[]) => PostedAt[] }) {
    this.signs = signs;
  }

  status() {
    this.today();
    return { tmapCallsToday: this.calls.n, budget: TMAP_DAY_BUDGET, nodelink: this.links.ready, lastError: this.lastError };
  }

  private today() {
    const day = new Date(this.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    if (this.calls.day !== day) this.calls = { day, n: 0 };
  }
  private canAskTmap(): boolean {
    this.today();
    return !!this.tmapKey() && this.calls.n < TMAP_DAY_BUDGET;
  }
  private sweep() {
    if (this.now() - this.sweptAt < 3_600_000) return;
    this.sweptAt = this.now();
    this.remembered.sweep();
  }

  /** The route's limits, as runs of path positions. */
  async alongRoute(path: LonLat[]): Promise<{ runs: LimitRun[]; tmapShare: number }> {
    this.sweep();
    const samples = resample(path);
    const kmh: (number | null)[] = samples.map(() => null);
    const src: (LimitSource | null)[] = samples.map(() => null);
    // TMAP: what was asked today first, the rest asked in runs of points next to one another (a trajectory, as it wants).
    for (let i = 0; i < samples.length; i++) {
      const v = this.remembered.near(samples[i].p, samples[i].deg);
      if (v != null) { kmh[i] = v; src[i] = "tmap"; }
    }
    const missing: number[][] = [];
    for (let i = 0; i < samples.length; i++) {
      if (kmh[i] != null) continue;
      const run = missing[missing.length - 1];
      if (run && run[run.length - 1] === i - 1) run.push(i); else missing.push([i]);
    }
    for (const run of missing) {
      for (let s = 0; s < run.length; s += TMAP_PER_CALL) {
        if (!this.canAskTmap()) break;
        let ids = run.slice(s, s + TMAP_PER_CALL);
        // One point is no trajectory: its neighbours go along.
        if (ids.length === 1) ids = [ids[0] - 1, ids[0], ids[0] + 1].filter((i) => i >= 0 && i < samples.length);
        await this.matchTmap(ids.map((i) => samples[i])).then((got) => {
          got.forEach((v, k) => { if (v != null && kmh[ids[k]] == null) { kmh[ids[k]] = v; src[ids[k]] = "tmap"; } });
        }).catch((e) => { this.lastError = `TMAP ${(e as Error).message}`; });
      }
    }
    // 표준노드링크 where TMAP said nothing.
    if (kmh.some((v) => v == null)) {
      const nl = await this.nodelinkAlong(samples).catch((e) => { this.lastError = `노드링크 ${(e as Error).message}`; return [] as (number | null)[]; });
      nl.forEach((v, i) => { if (kmh[i] == null && v != null) { kmh[i] = v; src[i] = "nodelink"; } });
    }
    // The speed signs by the road (정밀도로지도), over both.
    if (this.signs?.ready) overlaySigns(samples, kmh, src, this.signs.along(path));
    // Runs: each sample holds from halfway back to halfway on.
    const runs: LimitRun[] = [];
    for (let i = 0; i < samples.length; i++) {
      const v = kmh[i];
      if (v == null) continue;
      const from = i === 0 ? 0 : (samples[i - 1].at + samples[i].at) / 2;
      const to = i === samples.length - 1 ? samples[i].at : (samples[i].at + samples[i + 1].at) / 2;
      const last = runs[runs.length - 1];
      if (last && last.kmh === v && last.src === src[i] && Math.abs(last.to - from) < 1e-9) last.to = to;
      else runs.push({ from, to, kmh: v, src: src[i]! });
    }
    const tmapShare = samples.length ? src.filter((s) => s === "tmap").length / samples.length : 0;
    return { runs: smooth(runs, samples), tmapShare };
  }

  /** TMAP's limit for each point, matched on its road; null where it put the point on another. */
  private async matchTmap(points: Sample[]): Promise<(number | null)[]> {
    this.calls.n++;
    const body = `responseType=1&coords=${encodeURIComponent(points.map((s) => `${s.p[0].toFixed(6)},${s.p[1].toFixed(6)}`).join("|"))}`;
    const a = await this.fetchJson("https://apis.openapi.sk.com/tmap/road/matchToRoads?version=1", {
      method: "POST",
      headers: { appKey: this.tmapKey()!, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    const j = (await a.json().catch(() => ({}))) as { resultData?: { matchedPoints?: TmapPoint[] }; error?: { code?: string } };
    if (a.status === 429) { this.calls.n = TMAP_DAY_BUDGET; throw new Error("하루 한도"); }
    if (a.status !== 200) throw new Error(j.error?.code ?? String(a.status));
    const out: (number | null)[] = points.map(() => null);
    for (const m of j.resultData?.matchedPoints ?? []) {
      if (m.sourceIndex == null || out[m.sourceIndex] != null || !plausible(m.speed)) continue;
      const s = points[m.sourceIndex];
      const got: LonLat = [m.matchedLocation.longitude, m.matchedLocation.latitude];
      if (metres(s.p, got) > MATCH_OFF_M) continue;
      out[m.sourceIndex] = m.speed;
      this.remembered.put(s.p, s.deg, m.speed);
    }
    return out;
  }

  /** 표준노드링크's limit at each sample: OSRM along the route's own way, its nodes read as links end to end. */
  private async nodelinkAlong(samples: Sample[]): Promise<(number | null)[]> {
    const out: (number | null)[] = samples.map(() => null);
    const base = this.osrmUrl();
    if (!base || !this.links.ready || samples.length < 2) return out;
    const way = samples.filter((_, i) => i % WAYPOINT_EVERY === 0 || i === samples.length - 1);
    // Nodes in order, each edge with the route distance (samples' m) it covers.
    const nodes: string[] = [], edgeFrom: number[] = [], edgeTo: number[] = [];
    for (let s = 0; s < way.length - 1; s += 99) {
      const part = way.slice(s, s + 100);
      let j: { code?: string; message?: string; routes?: { legs: { annotation: { nodes: number[]; distance: number[] } }[] }[] } = {};
      // A point on a lane 표준노드링크 does not have (the start in a side street) snaps nowhere and fails the lot: it is
      // left out (OSRM names it) and the rest asked again.
      for (let tries = 0; tries < 8 && part.length >= 2; tries++) {
        const coords = part.map((w) => `${w.p[0].toFixed(6)},${w.p[1].toFixed(6)}`).join(";");
        const bearings = part.map((w) => `${Math.round(w.deg)},45`).join(";");
        const a = await this.fetchJson(`${base}/route/v1/driving/${coords}?overview=false&annotations=nodes,distance&continue_straight=true&bearings=${bearings}&radiuses=${part.map(() => "25").join(";")}`);
        j = (await a.json()) as typeof j;
        const bad = j.code === "NoSegment" ? Number(/coordinate (\d+)/.exec(j.message ?? "")?.[1]) : NaN;
        if (!Number.isInteger(bad) || bad < 0 || bad >= part.length) break;
        part.splice(bad, 1);
      }
      if (j.code !== "Ok" || !j.routes?.length) continue;
      j.routes[0].legs.forEach((leg, li) => {
        const n = leg.annotation.nodes.map(String), d = leg.annotation.distance;
        const m0 = part[li].m, m1 = part[li + 1].m, total = d.reduce((x, y) => x + y, 0) || 1;
        if (!nodes.length || nodes[nodes.length - 1] !== n[0]) {
          if (nodes.length) { edgeFrom.push(m0); edgeTo.push(m0); }
          nodes.push(n[0]);
        }
        let acc = 0;
        for (let i = 0; i < d.length; i++) {
          const from = m0 + (acc / total) * (m1 - m0);
          acc += d[i];
          nodes.push(n[i + 1]);
          edgeFrom.push(from);
          edgeTo.push(m0 + (acc / total) * (m1 - m0));
        }
      });
    }
    // A link is read where both its ends are on the route, in its order.
    const where = new Map<string, number[]>();
    nodes.forEach((v, i) => { const l = where.get(v); if (l) l.push(i); else where.set(v, [i]); });
    const limit: (number | null)[] = edgeFrom.map(() => null);
    for (let i = 0; i < nodes.length - 1; i++) {
      for (const r of this.links.from(nodes[i])) {
        const k = (where.get(r.t) ?? []).find((k) => k > i && k - i < 5000);
        if (k != null && plausible(r.maxspd)) for (let e = i; e < k; e++) limit[e] = r.maxspd;
      }
    }
    let e = 0;
    for (let q = 0; q < samples.length; q++) {
      while (e < edgeTo.length - 1 && edgeTo[e] < samples[q].m) e++;
      if (e < limit.length && edgeFrom[e] <= samples[q].m + 1) out[q] = limit[e];
    }
    return out;
  }

  /**
   * The limit where a car is that has no route (or has left it): TMAP's remembered answer, TMAP's nearest road, the
   * last TMAP said to this car while it goes on the same way, or 표준노드링크's. That last: between two of TMAP's answers
   * 표준노드링크's came in, and where the two differ the sign went 60, 70, 60, 70 (무안, 2026-10-14).
   */
  async here(who: string, p: LonLat, deg: number | null): Promise<{ kmh: number | null; src: LimitSource | null }> {
    this.sweep();
    const told = (kmh: number) => { if (deg != null) this.lastTold.set(who, { kmh, p, deg, t: this.now() }); return { kmh, src: "tmap" as const }; };
    if (deg != null) {
      const v = this.remembered.near(p, deg);
      if (v != null) return told(v);
    }
    const last = this.hereAskedAt.get(who) ?? 0;
    if (deg != null && this.canAskTmap() && this.now() - last >= HERE_EVERY_MS) {
      this.hereAskedAt.set(who, this.now());
      const v = await this.nearTmap(p, deg).catch((e) => { this.lastError = `TMAP ${(e as Error).message}`; return null; });
      if (v != null) return told(v);
    }
    const before = this.lastTold.get(who);
    if (before && deg != null && this.now() - before.t <= HOLD_MS && metres(before.p, p) <= HOLD_M && turn(before.deg, deg) <= HOLD_DEG) {
      return { kmh: before.kmh, src: "tmap" };
    }
    const v = await this.nearNodelink(p, deg).catch((e) => { this.lastError = `노드링크 ${(e as Error).message}`; return null; });
    return v != null ? { kmh: v, src: "nodelink" } : { kmh: null, src: null };
  }

  private async nearTmap(p: LonLat, deg: number): Promise<number | null> {
    this.calls.n++;
    const a = await this.fetchJson(`https://apis.openapi.sk.com/tmap/road/nearToRoad?version=1&lat=${p[1].toFixed(6)}&lon=${p[0].toFixed(6)}&appKey=${encodeURIComponent(this.tmapKey()!)}`);
    if (a.status === 429) { this.calls.n = TMAP_DAY_BUDGET; throw new Error("하루 한도"); }
    if (a.status !== 200) throw new Error(String(a.status));
    const j = (await a.json()) as { resultData?: { header?: { speed?: number }; linkPoints?: { location: { latitude: number; longitude: number } }[] } };
    const speed = j.resultData?.header?.speed;
    const pts = (j.resultData?.linkPoints ?? []).map((l) => [l.location.longitude, l.location.latitude] as LonLat);
    if (!plausible(speed) || pts.length < 2) return null;
    // The road it found must be under the car and run its way (not the road over it, nor the one across).
    let best: { d: number; deg: number } | null = null;
    for (let i = 1; i < pts.length; i++) {
      const d = toSegment(p, pts[i - 1], pts[i]);
      if (!best || d < best.d) best = { d, deg: bearing(pts[i - 1], pts[i]) };
    }
    if (!best || best.d > MATCH_OFF_M || along(best.deg, deg) > 40) return null;
    // The link's whole length remembered: the car goes on along it without asking again.
    for (let i = 1; i < pts.length; i++) {
      const d = metres(pts[i - 1], pts[i]), b = bearing(pts[i - 1], pts[i]);
      for (let m = 0; m <= d; m += 10) {
        const t = d ? m / d : 0;
        this.remembered.put([pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])], b, speed);
      }
    }
    return speed;
  }

  /**
   * 표준노드링크's limit under a moving car: OSRM a few tens of metres on, the car's way, and the first link its nodes
   * name — an inner vertex by its link's block, else two ends in a row. (OSRM's nearest names one end as 0.)
   */
  private async nearNodelink(p: LonLat, deg: number | null): Promise<number | null> {
    const base = this.osrmUrl();
    if (!base || deg == null || !this.links.ready) return null;
    const k = Math.cos(p[1] * RAD), ahead: LonLat = [p[0] + (Math.sin(deg * RAD) * 60) / (R * RAD * k), p[1] + (Math.cos(deg * RAD) * 60) / (R * RAD)];
    const coords = `${p[0].toFixed(6)},${p[1].toFixed(6)};${ahead[0].toFixed(6)},${ahead[1].toFixed(6)}`;
    const a = await this.fetchJson(`${base}/route/v1/driving/${coords}?overview=false&annotations=nodes&bearings=${Math.round(deg)},45;${Math.round(deg)},90&radiuses=25;60`);
    const j = (await a.json()) as { code?: string; routes?: { legs: { annotation: { nodes: number[] } }[] }[]; waypoints?: { distance: number }[] };
    const nodes = j.routes?.[0]?.legs[0]?.annotation.nodes;
    if (j.code !== "Ok" || !nodes?.length || (j.waypoints?.[0]?.distance ?? Infinity) > MATCH_OFF_M) return null;
    for (const n of nodes) {
      if (n < INNER_ID) continue;
      const v = this.links.inner(n);
      return plausible(v) ? v : null;
    }
    for (let i = 0; i + 1 < nodes.length; i++) {
      const v = this.links.ends(nodes[i], nodes[i + 1]);
      if (v != null) return plausible(v) ? v : null;
    }
    return null;
  }
}

interface TmapPoint {
  sourceIndex?: number;
  speed?: number;
  matchedLocation: { latitude: number; longitude: number };
}

/** Metres from [p] to the segment [a, b]. */
function toSegment(p: LonLat, a: LonLat, b: LonLat): number {
  const k = Math.cos(p[1] * RAD);
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1], bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy) * RAD * R;
}

/** [runs] with each blip (shorter than BLIP_M, the same limit before and after it) given its neighbours' limit, and joined. */
export function smooth(runs: LimitRun[], samples: Sample[]): LimitRun[] {
  if (runs.length < 2) return runs;
  // A path position's metres, from the samples (each carries both).
  const metresAt = (x: number) => {
    let i = 0;
    while (i + 1 < samples.length && samples[i + 1].at <= x) i++;
    const a = samples[i], b = samples[Math.min(i + 1, samples.length - 1)];
    return b.at > a.at ? a.m + ((x - a.at) / (b.at - a.at)) * (b.m - a.m) : a.m;
  };
  const out = runs.map((r) => ({ ...r }));
  for (let i = 1; i + 1 < out.length; i++) {
    const before = out[i - 1], r = out[i], after = out[i + 1];
    const touching = Math.abs(before.to - r.from) < 1e-9 && Math.abs(r.to - after.from) < 1e-9;
    // A sign's run is what is posted: not a junction's link to be smoothed away.
    if (touching && r.src !== "sign" && before.kmh === after.kmh && r.kmh !== before.kmh && metresAt(r.to) - metresAt(r.from) < BLIP_M) {
      r.kmh = before.kmh;
      r.src = before.src;
    }
  }
  // Joined where the limit is the same: touching, or across a short gap (a point dropped as no limit, or matched elsewhere).
  const joined: LimitRun[] = [];
  for (const r of out) {
    const last = joined[joined.length - 1];
    const gap = last ? metresAt(r.from) - metresAt(last.to) : Infinity;
    if (last && last.kmh === r.kmh && (Math.abs(last.to - r.from) < 1e-9 || gap < BLIP_M)) last.to = r.to;
    else joined.push(r);
  }
  return joined;
}
