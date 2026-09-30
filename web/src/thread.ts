import { Line, bearing, metres } from "./geo";
import type { LonLat, Route } from "./types";

/**
 * A route's corners as the lanes are painted. The providers' lines cut
 * across a junction from the last point before it to the first after,
 * while 정밀도로지도 has the turning lane's own arc; where the server can
 * thread the turn (/api/hdmap/thread, server/src/lanes.ts), that arc
 * takes the place of the cut in route.path — the line on the map and
 * the car's matching both follow it. Indices into the path (congestion
 * segments, motorway ranges) are moved along with it.
 */
/** A bend of at least this at a guide is a corner worth threading. */
const BEND_DEG = 25;
/** The splice must start within this of the route and rejoin it this close. */
const START_OFF_M = 12;
const REJOIN_M = 4;

export interface Turn { at: LonLat; in: number; after: LonLat[] }

/** The turns of [route] worth threading: each guide where the line bends, with the way in and the route after. */
export function turnsOf(route: Route, line = new Line(route.path)): { guide: number; turn: Turn }[] {
  const out: { guide: number; turn: Turn }[] = [];
  route.guides.forEach((g, i) => {
    const p = line.project(g.at, 0, line.path.length);
    if (p.offM > 30 || p.alongM < 30 || p.alongM > line.lengthM - 30) return;
    const before = line.place(p.alongM - 30).at, ahead = line.place(Math.min(line.lengthM, p.alongM + 40)).at;
    const inDeg = bearing(before[0], before[1], p.at[0], p.at[1]);
    const outDeg = bearing(p.at[0], p.at[1], ahead[0], ahead[1]);
    if (Math.abs(((outDeg - inDeg + 540) % 360) - 180) < BEND_DEG) return;
    const after = Array.from({ length: 11 }, (_, k) => line.place(Math.min(line.lengthM, p.alongM + k * 15)).at);
    out.push({ guide: i, turn: { at: g.at, in: Math.round(inDeg), after } });
  });
  return out;
}

/**
 * [trail] (from a lane's end at the stop line, on through the junction)
 * put into [route] in place of the cut it replaces: from where the trail
 * starts on the route to where it rejoins it. Returns whether it fitted.
 */
export function splice(route: Route, trail: LonLat[]): boolean {
  if (trail.length < 2) return false;
  const line = new Line(route.path);
  const s = line.project(trail[0], 0, line.path.length);
  if (s.offM > START_OFF_M) return false;
  // Where the trail meets the route again: the first trail point past 20 m that lies on it.
  let k = -1, e = s, walked = 0;
  for (let i = 1; i < trail.length; i++) {
    walked += metres(trail[i - 1][0], trail[i - 1][1], trail[i][0], trail[i][1]);
    if (walked < 20) continue;
    const p = line.project(trail[i], s.segment, 60);
    if (p.offM <= REJOIN_M && p.alongM > s.alongM + 10) { k = i; e = p; break; }
  }
  if (k < 0) return false;
  const inserted: LonLat[] = [s.at, ...trail.slice(0, k + 1), e.at];
  const first = s.segment + 1, past = e.segment + 1;
  const delta = inserted.length - (past - first);
  route.path = [...route.path.slice(0, first), ...inserted, ...route.path.slice(past)];
  const move = (i: number) => (i < first ? i : i >= past ? i + delta : first);
  for (const seg of route.segments) { seg.from = move(seg.from); seg.to = move(seg.to); }
  route.segments = route.segments.filter((seg) => seg.to > seg.from);
  if (route.motorways) route.motorways = route.motorways.map(([a, b]) => [move(a), move(b)] as [number, number]).filter(([a, b]) => b > a);
  return true;
}

/** Snapped vertices in one call to the server (its SNAP_BATCH). */
const SNAP_BATCH = 4000;
/** A vertex without lanes of its own within this many metres of one with them borrows a fading share of its shift. */
const BLEND_M = 60;

/** The route's heading at each vertex: from the one before to the one after (the ends from their one neighbour). */
export function headingsOf(path: LonLat[]): number[] {
  return path.map((p, i) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    return a === b ? NaN : bearing(a[0], a[1], b[0], b[1]);
  });
}

/**
 * [path] moved onto [snapped] where there is one; a vertex without one
 * near vertices with them is moved part of the way, fading out over
 * BLEND_M, so the line slides onto the lanes and off them without a jog.
 */
export function applySnap(path: LonLat[], snapped: (LonLat | null)[]): LonLat[] {
  const n = path.length;
  const shift: (readonly [number, number] | null)[] = snapped.map((s, i) => (s ? [s[0] - path[i][0], s[1] - path[i][1]] as const : null));
  const along: number[] = [0];
  for (let i = 1; i < n; i++) along.push(along[i - 1] + metres(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]));
  return path.map((p, i) => {
    if (shift[i]) return [p[0] + shift[i]![0], p[1] + shift[i]![1]];
    // The nearest shifted vertex either way within BLEND_M, its shift scaled down by the distance.
    let best: { d: number; s: readonly [number, number] } | null = null;
    for (let j = i - 1; j >= 0 && along[i] - along[j] <= BLEND_M; j--) if (shift[j]) { best = { d: along[i] - along[j], s: shift[j]! }; break; }
    for (let j = i + 1; j < n && along[j] - along[i] <= BLEND_M; j++) if (shift[j]) { const d = along[j] - along[i]; if (!best || d < best.d) best = { d, s: shift[j]! }; break; }
    if (!best) return p;
    const share = 1 - best.d / BLEND_M;
    return [p[0] + best.s[0] * share, p[1] + best.s[1] * share];
  });
}

/** [route] with its line on the travel-direction lanes wherever 정밀도로지도 has them; as it came elsewhere. */
export async function snapRoute(route: Route): Promise<Route> {
  try {
    const headings = headingsOf(route.path);
    const snapped: (LonLat | null)[] = [];
    for (let i = 0; i < route.path.length; i += SNAP_BATCH) {
      const a = await fetch("/api/hdmap/snap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ points: route.path.slice(i, i + SNAP_BATCH), headings: headings.slice(i, i + SNAP_BATCH) }) });
      if (!a.ok) return route;
      snapped.push(...((await a.json()) as { at: (LonLat | null)[] }).at);
    }
    if (snapped.some(Boolean)) route.path = applySnap(route.path, snapped);
  } catch { /* the line as the provider drew it */ }
  return route;
}

/** [route] with every corner the server can thread taken from the painted lanes; the route as it came where it cannot. */
export async function threadRoute(route: Route): Promise<Route> {
  try {
    const turns = turnsOf(route);
    if (turns.length === 0) return route;
    const a = await fetch("/api/hdmap/thread", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turns: turns.map((t) => t.turn) }) });
    if (!a.ok) return route;
    const { trails } = (await a.json()) as { trails: (LonLat[] | null)[] };
    // Later corners first: a splice before them would move their indices, not their places, but the line is remade each time anyway.
    for (const trail of trails) if (trail) splice(route, trail);
  } catch { /* the corners as the provider drew them */ }
  return route;
}
