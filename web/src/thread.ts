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
/**
 * The joins are moved back and on along the route this many metres for
 * every metre the trail sits beside it (a slope of about 14°): a trail
 * on the outer lane of a wide road starts 10 m from the provider's
 * centreline, and a line that stepped straight across to it would be
 * the zigzag seen at 잠실3사거리.
 */
const TAPER = 4;
/** And at least this long: after snapping, the route beside the trail's end sits on the carriageway's middle, a lane or two over. */
const TAPER_MIN_M = 40;
/** The way the trail rejoins must be the route's way: more than this between them is a wrong turn's lane. */
const REJOIN_DEG = 45;
/** A trail longer than this times the stretch it replaces (plus a junction's width) has wandered. */
const TRAIL_STRETCH = 1.6;
const TRAIL_SLACK_M = 20;
/** A trail's first leg shorter than this, at an angle to the next, is a survey's step, not the lane's way. */
const TRAIL_STEP_M = 3;

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
  trail = distinct(trail);
  // A lane's end surveyed a step beside the link it joins (a short first leg at an angle to the next): the trail starts past it.
  while (trail.length > 2 && metres(trail[0][0], trail[0][1], trail[1][0], trail[1][1]) < TRAIL_STEP_M
    && Math.abs(((bearing(trail[1][0], trail[1][1], trail[2][0], trail[2][1]) - bearing(trail[0][0], trail[0][1], trail[1][0], trail[1][1]) + 540) % 360) - 180) > BEND_DEG) trail = trail.slice(1);
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
  // Rejoining at an angle, or after a long way round: another lane's trail, not this turn's.
  const outDeg = bearing(trail[k - 1][0], trail[k - 1][1], trail[k][0], trail[k][1]);
  if (Math.abs(((e.bearing - outDeg + 540) % 360) - 180) > REJOIN_DEG) return false;
  if (walked > TRAIL_STRETCH * (e.alongM - s.alongM) + TRAIL_SLACK_M) return false;
  // The joins slid back and on along the route, so the line slopes onto the trail and off it — but not into a trail already in.
  // — nor past a bend of the route's own (a U-turn's tip would be cut), nor into a trail already in.
  const threaded = route.threaded ?? [];
  const bends = route.path.map((_, i) => (i > 0 && i + 1 < route.path.length ? Math.abs(((bearing(route.path[i][0], route.path[i][1], route.path[i + 1][0], route.path[i + 1][1]) - bearing(route.path[i - 1][0], route.path[i - 1][1], route.path[i][0], route.path[i][1]) + 540) % 360) - 180) : 0));
  let floor = Math.max(0, ...threaded.filter(([, to]) => to - 1 <= s.segment).map(([, to]) => line.along[to - 1]));
  for (let i = s.segment; i > 0; i--) if (bends[i] >= BEND_DEG) { floor = Math.max(floor, line.along[i]); break; }
  let ceiling = Math.min(line.lengthM, ...threaded.filter(([from]) => from > e.segment).map(([from]) => line.along[from]));
  for (let i = e.segment + 1; i + 1 < route.path.length; i++) if (bends[i] >= BEND_DEG) { ceiling = Math.min(ceiling, line.along[i]); break; }
  const sb = line.place(Math.max(floor, s.alongM - Math.max(TAPER_MIN_M, TAPER * s.offM)));
  const eb = line.place(Math.min(ceiling, e.alongM + Math.max(TAPER_MIN_M, TAPER * e.offM)));
  const first = sb.segment + 1, past = eb.segment + 1;
  const arc = trail.slice(0, k + 1);
  const head = first > 0 && metres(route.path[first - 1][0], route.path[first - 1][1], sb.at[0], sb.at[1]) < 0.5 ? [] : [sb.at];
  const tail = past < route.path.length && metres(route.path[past][0], route.path[past][1], eb.at[0], eb.at[1]) < 0.5 ? [] : [eb.at];
  const inserted: LonLat[] = [...head, ...arc, ...tail];
  const delta = inserted.length - (past - first);
  route.path = [...route.path.slice(0, first), ...inserted, ...route.path.slice(past)];
  const move = (i: number) => (i < first ? i : i >= past ? i + delta : first);
  for (const seg of route.segments) { seg.from = move(seg.from); seg.to = move(seg.to); }
  route.segments = route.segments.filter((seg) => seg.to > seg.from);
  if (route.motorways) route.motorways = route.motorways.map(([a, b]) => [move(a), move(b)] as [number, number]).filter(([a, b]) => b > a);
  const from = first + head.length;
  route.threaded = [...threaded.map(([a, b]) => [move(a), move(b)] as [number, number]).filter(([a, b]) => b > a), [from, from + arc.length] as [number, number]].sort((a, b) => a[0] - b[0]);
  return true;
}

/** [points] without a point repeating the one before it. */
function distinct(points: LonLat[]): LonLat[] {
  return points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
}

/** Snapped vertices in one call to the server (its SNAP_BATCH). */
const SNAP_BATCH = 4000;
/** A vertex without lanes of its own within this many metres of one with them borrows a fading share of its shift. */
const BLEND_M = 60;
/**
 * How fast the line may slide sideways between two snapped vertices, in
 * metres per metre along (about 9°), plus a tolerance for the survey's
 * own noise. A real lane change is 3.5 m over 50 m; a vertex snapped to a
 * crossing road's lane, or to the far side of a junction, sits 10–15 m
 * from its neighbours' shift with nothing between — the step in the line.
 */
const SLOPE = 0.15;
const SLOPE_TOL_M = 1;
/** A bend the snapping put into the line (none this sharp in the provider's) is undone there. */
const KINK_DEG = 50;
const KINK_ROUNDS = 3;

/**
 * The route's heading at each vertex: from the nearest different point
 * before to the nearest after (the ends from their one neighbour). The
 * providers repeat a guide's vertex; counted as one, both copies get the
 * same heading, rather than one the road in and the other the road out.
 */
export function headingsOf(path: LonLat[]): number[] {
  const n = path.length;
  const same = (a: LonLat, b: LonLat) => a[0] === b[0] && a[1] === b[1];
  return path.map((p, i) => {
    let a = i - 1, b = i + 1;
    while (a >= 0 && same(path[a], p)) a--;
    while (b < n && same(path[b], p)) b++;
    const from = a >= 0 ? path[a] : p, to = b < n ? path[b] : p;
    return same(from, to) ? NaN : bearing(from[0], from[1], to[0], to[1]);
  });
}

/**
 * [path] moved beside each vertex's snap where there is one and it agrees
 * with its neighbours (only sideways: a lane's nearest point to a vertex
 * on a bend lies metres ahead of or behind it, which would bunch the
 * vertices up); a vertex without one is moved between the nearest with
 * (or fixed) either way, fading out over BLEND_M past the last, so the
 * line slides onto the lanes and off them without a jog. [fixed] marks
 * vertices already on a lane (a threaded corner): they stay, and the
 * line slides onto them like onto a snapped one.
 */
export function applySnap(path: LonLat[], snapped: (LonLat | null)[], fixed: boolean[] = []): LonLat[] {
  const n = path.length;
  const headings = headingsOf(path);
  const along: number[] = [0];
  for (let i = 1; i < n; i++) along.push(along[i - 1] + metres(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]));
  const kx = 111_320 * Math.cos(((path[0]?.[1] ?? 0) * Math.PI) / 180), ky = 111_320;
  const keep = snapped.map((s, i) => (s && !fixed[i] && Number.isFinite(headings[i]) ? s : null));
  const bendAt = (q: LonLat[], i: number): number => {
    let a = i - 1, b = i + 1;
    while (a >= 0 && metres(q[a][0], q[a][1], q[i][0], q[i][1]) < 0.3) a--;
    while (b < n && metres(q[b][0], q[b][1], q[i][0], q[i][1]) < 0.3) b++;
    if (a < 0 || b >= n) return 0;
    return Math.abs(((bearing(q[i][0], q[i][1], q[b][0], q[b][1]) - bearing(q[a][0], q[a][1], q[i][0], q[i][1]) + 540) % 360) - 180);
  };
  for (let round = 0; round <= KINK_ROUNDS; round++) {
    // Each snap's sideways part, in the route's frame there; one out of step with both neighbours (which agree) goes;
    // then of two neighbours out of step with each other, the one further from the line as drawn.
    const lateral = keep.map((s, i) => {
      if (!s) return NaN;
      const dx = (s[0] - path[i][0]) * kx, dy = (s[1] - path[i][1]) * ky, h = (headings[i] * Math.PI) / 180;
      return dx * Math.cos(h) - dy * Math.sin(h);
    });
    const agree = (i: number, j: number) => Math.abs(lateral[i] - lateral[j]) <= SLOPE * Math.abs(along[i] - along[j]) + SLOPE_TOL_M;
    const have = keep.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
    const drop = new Set<number>();
    for (let k = 1; k + 1 < have.length; k++) {
      const a = have[k - 1], i = have[k], b = have[k + 1];
      if (agree(a, b) && !agree(i, a) && !agree(i, b)) drop.add(i);
    }
    let last = -1;
    for (const i of have) {
      if (drop.has(i)) continue;
      if (last < 0 || agree(last, i)) { last = i; continue; }
      if (Math.abs(lateral[i]) > Math.abs(lateral[last])) drop.add(i); else { drop.add(last); last = i; }
    }
    for (const i of drop) keep[i] = null;
    const shift: (readonly [number, number] | null)[] = keep.map((s, i) => {
      if (!s) return fixed[i] ? ([0, 0] as const) : null;
      const h = (headings[i] * Math.PI) / 180;
      return [(lateral[i] * Math.cos(h)) / kx, (-lateral[i] * Math.sin(h)) / ky] as const;
    });
    const moved = path.map((p, i) => {
      if (shift[i]) return [p[0] + shift[i]![0], p[1] + shift[i]![1]] as LonLat;
      let before: number | null = null, after: number | null = null;
      for (let j = i - 1; j >= 0 && along[i] - along[j] <= BLEND_M; j--) if (shift[j]) { before = j; break; }
      for (let j = i + 1; j < n && along[j] - along[i] <= BLEND_M; j++) if (shift[j]) { after = j; break; }
      if (before === null && after === null) return p;
      let sx: number, sy: number;
      if (before !== null && after !== null) {
        const span = along[after] - along[before], t = span > 0 ? (along[i] - along[before]) / span : 0.5;
        sx = shift[before]![0] + (shift[after]![0] - shift[before]![0]) * t;
        sy = shift[before]![1] + (shift[after]![1] - shift[before]![1]) * t;
      } else {
        const j = (before ?? after)!, share = 1 - Math.abs(along[i] - along[j]) / BLEND_M;
        sx = shift[j]![0] * share; sy = shift[j]![1] * share;
      }
      return [p[0] + sx, p[1] + sy] as LonLat;
    });
    // A bend the snapping made where the line as drawn had none: that snap goes, and the line is laid again.
    const kinks: number[] = [];
    for (let i = 1; i + 1 < n; i++) if (keep[i] && bendAt(moved, i) >= KINK_DEG && bendAt(path, i) < KINK_DEG / 2) kinks.push(i);
    if (kinks.length === 0 || round === KINK_ROUNDS) return moved;
    for (const i of kinks) keep[i] = null;
  }
  return path;
}

/** [route] with its line on the travel-direction lanes wherever 정밀도로지도 has them; as it came elsewhere. */
export async function snapRoute(route: Route): Promise<Route> {
  try {
    const fixed: boolean[] = [];
    for (const [a, b] of route.threaded ?? []) for (let i = a; i < b; i++) fixed[i] = true;
    // A threaded corner is on its lane already: not asked about (a NaN heading comes back null).
    const headings = headingsOf(route.path).map((h, i) => (fixed[i] ? NaN : h));
    const snapped: (LonLat | null)[] = [];
    for (let i = 0; i < route.path.length; i += SNAP_BATCH) {
      const a = await fetch("/api/hdmap/snap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ points: route.path.slice(i, i + SNAP_BATCH), headings: headings.slice(i, i + SNAP_BATCH) }) });
      if (!a.ok) return route;
      snapped.push(...((await a.json()) as { at: (LonLat | null)[] }).at);
    }
    if (snapped.some(Boolean)) route.path = applySnap(route.path, snapped, fixed);
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
