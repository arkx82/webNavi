import { Line, bearing, metres } from "./geo";
import type { LonLat, Route } from "./types";
import { maneuverOf } from "./maneuver";

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
 * Failing that, a trail running alongside the route this close and this
 * nearly parallel rejoins it: a right turn into the outer lane of a wide
 * road stays 8 m from the provider's centreline, and never came within 4.
 */
const REJOIN_FAR_M = 9;
const REJOIN_PARALLEL_DEG = 15;
/** A trail rejoins the route this far past the turn's guide at the least: before it, it is still on the way in. */
const PAST_TURN_M = 5;
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

export interface Turn { at: LonLat; in: number; after: LonLat[]; before?: LonLat[] }

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
    // The 80 m in, for the lanes under the route before the junction (a slip lane leaves its road before the stop line).
    const way = Array.from({ length: 17 }, (_, k) => line.place(Math.max(0, p.alongM - 80 + k * 5)).at);
    out.push({ guide: i, turn: { at: g.at, in: Math.round(inDeg), after, before: way } });
  });
  return out;
}

/**
 * [trail] (from a lane's end at the stop line, on through the junction)
 * put into [route] in place of the cut it replaces: from where the trail
 * starts on the route to where it rejoins it. Returns whether it fitted.
 */
export function splice(route: Route, trail: LonLat[], at?: LonLat): boolean {
  trail = distinct(trail);
  // A lane's end surveyed a step beside the link it joins (a short first leg at an angle to the next): the trail starts past it.
  while (trail.length > 2 && metres(trail[0][0], trail[0][1], trail[1][0], trail[1][1]) < TRAIL_STEP_M
    && Math.abs(((bearing(trail[1][0], trail[1][1], trail[2][0], trail[2][1]) - bearing(trail[0][0], trail[0][1], trail[1][0], trail[1][1]) + 540) % 360) - 180) > BEND_DEG) trail = trail.slice(1);
  if (trail.length < 2) return false;
  const line = new Line(route.path);
  const s = line.project(trail[0], 0, line.path.length);
  if (s.offM > START_OFF_M) return false;
  // Where the trail meets the route again: the first trail point past 20 m that lies on it, past the turn. A trail
  // from the lanes 70 m before the junction (a slip lane's, lanes.threadAlong) runs on the route all the way in, and
  // was taken as rejoined there: the approach was replaced, the slip lane let go, and the line still cut through the
  // junction (경복아파트 사거리, 2026-10-13).
  const corner = at ? line.project(at, 0, line.path.length).alongM : null;
  const past = (p: { alongM: number }) => p.alongM > s.alongM + 10 && (corner == null || p.alongM >= corner + PAST_TURN_M);
  let k = -1, e = s, walked = 0;
  for (let i = 1; i < trail.length; i++) {
    walked += metres(trail[i - 1][0], trail[i - 1][1], trail[i][0], trail[i][1]);
    if (walked < 20) continue;
    const p = line.project(trail[i], s.segment, 60);
    if (p.offM <= REJOIN_M && past(p)) { k = i; e = p; break; }
  }
  if (k < 0) {
    walked = 0;
    for (let i = 1; i < trail.length; i++) {
      walked += metres(trail[i - 1][0], trail[i - 1][1], trail[i][0], trail[i][1]);
      if (walked < 30) continue;
      const p = line.project(trail[i], s.segment, 60);
      const deg = bearing(trail[i - 1][0], trail[i - 1][1], trail[i][0], trail[i][1]);
      if (p.offM <= REJOIN_FAR_M && past(p) && Math.abs(((p.bearing - deg + 540) % 360) - 180) <= REJOIN_PARALLEL_DEG) { k = i; e = p; break; }
    }
  }
  if (k < 0) return false;
  // On along the trail while it keeps to the route: the lanes' line as far as it goes, and the straight step from it
  // to the route as short as can be — from the first point back, it cut across a road still bending (중계역,
  // 화양사거리, 2026-10-13).
  // A lane beside the route's line (the inner lane round a loop ramp, 5 m in) is still the route's way.
  while (k + 1 < trail.length) {
    const p = line.project(trail[k + 1], e.segment, 60);
    const deg = bearing(trail[k][0], trail[k][1], trail[k + 1][0], trail[k + 1][1]);
    if (p.offM > REJOIN_FAR_M || p.alongM <= e.alongM || Math.abs(((p.bearing - deg + 540) % 360) - 180) > REJOIN_DEG) break;
    k++;
    e = p;
  }
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
  rewrite(route, sb, eb, trail.slice(0, k + 1), true);
  return true;
}

/**
 * [route.path] from [sb] to [eb] (places on it) given [arc] in between
 * instead, the indices into the path (congestion, motorways, threaded
 * corners) moved with it; [threaded] marks the arc as a corner on the lanes.
 */
function rewrite(route: Route, sb: { at: LonLat; segment: number }, eb: { at: LonLat; segment: number }, arc: LonLat[], threaded: boolean) {
  const first = sb.segment + 1, past = eb.segment + 1;
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
  const kept = (route.threaded ?? []).map(([a, b]) => [move(a), move(b)] as [number, number]).filter(([a, b]) => b > a);
  route.threaded = (threaded ? [...kept, [from, from + arc.length] as [number, number]] : kept).sort((a, b) => a[0] - b[0]);
}

/**
 * A corner the lanes could not thread (no 정밀도로지도 there, or no lane
 * of it near the route), rounded: a right turn hugs the corner (about a
 * 10 m radius), a left one sweeps across the junction (about 22 m), the
 * way a car drives and the painted guide lines go — not the provider's
 * point where two straight lines meet. Gentle bends, forks and U-turns
 * are left as they are.
 */
const ROUND_R_M: Partial<Record<string, number>> = { right: 10, "sharp-right": 8, left: 22, "sharp-left": 18 };
const ROUND_MAX_T_M: Partial<Record<string, number>> = { right: 16, "sharp-right": 14, left: 28, "sharp-left": 24 };
/** A vertex bending this much (over ±8 m) is a corner, not a lane's arc. */
const HARD_DEG = 60;
export function roundCorners(route: Route) {
  if (route.path.length < 3) return;
  const corners: { along: number; r: number; tMax: number }[] = [];
  let line = new Line(route.path);
  const guideAlong = route.guides.map((g) => line.project(g.at, 0, line.path.length));
  route.guides.forEach((g, i) => {
    const kind = maneuverOf(route.provider, g);
    const r = ROUND_R_M[kind], tMax = ROUND_MAX_T_M[kind];
    if (r == null || tMax == null || guideAlong[i].offM > 30) return;
    // Room before and after: half the way to the guides either side.
    const prev = Math.max(0, ...guideAlong.slice(0, i).map((p) => p.alongM).filter((a) => a < guideAlong[i].alongM));
    const nexts = guideAlong.slice(i + 1).map((p) => p.alongM).filter((a) => a > guideAlong[i].alongM);
    const next = nexts.length ? Math.min(...nexts) : line.lengthM;
    corners.push({ along: guideAlong[i].alongM, r, tMax: Math.min(tMax, (guideAlong[i].alongM - prev) / 2, (next - guideAlong[i].alongM) / 2) });
  });
  // From the end, so the earlier corners' places along the line stay as measured.
  for (const c of corners.sort((a, b) => b.along - a.along)) {
    line = new Line(route.path);
    // The corner is the sharpest vertex within 20 m of the guide.
    let at = c.along, sharpest = 0;
    for (let i = 1; i + 1 < route.path.length; i++) {
      const a = line.along[i];
      if (Math.abs(a - c.along) > 20) continue;
      const before = line.place(Math.max(0, a - 8)).at, after = line.place(Math.min(line.lengthM, a + 8)).at;
      const bend = Math.abs(((bearing(route.path[i][0], route.path[i][1], after[0], after[1]) - bearing(before[0], before[1], route.path[i][0], route.path[i][1]) + 540) % 360) - 180);
      if (bend > sharpest) { sharpest = bend; at = a; }
    }
    const inAt = line.place(Math.max(0, at - 25)).at, cornerAt = line.place(at).at, outAt = line.place(Math.min(line.lengthM, at + 25)).at;
    const turn = Math.abs(((bearing(cornerAt[0], cornerAt[1], outAt[0], outAt[1]) - bearing(inAt[0], inAt[1], cornerAt[0], cornerAt[1]) + 540) % 360) - 180);
    if (turn < 30 || turn > 150) continue;
    const t = Math.min(c.tMax, c.r * Math.tan(((turn / 2) * Math.PI) / 180));
    if (t < 4 || at - t < 0 || at + t > line.lengthM) continue;
    // Not over a corner the lanes threaded — unless what they gave still has a hard corner in it (a lane's arc
    // bends a little at each vertex; one that ends at the junction's mouth leaves the provider's point there).
    const from = at - t, to = at + t;
    if (sharpest < HARD_DEG && (route.threaded ?? []).some(([a, b]) => line.along[Math.min(b, line.along.length - 1)] >= from && line.along[a] <= to)) continue;
    const sb = line.place(from), eb = line.place(to);
    // A quadratic curve from A to B with the corner as its control point: tangent to both roads where it meets them.
    const n = Math.max(4, Math.ceil((2 * t) / 2.5));
    const arc: LonLat[] = [];
    for (let k = 1; k < n; k++) {
      const u = k / n, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), cc = u * u;
      arc.push([a * sb.at[0] + b * cornerAt[0] + cc * eb.at[0], a * sb.at[1] + b * cornerAt[1] + cc * eb.at[1]]);
    }
    rewrite(route, sb, eb, arc, false);
  }
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
 * Before a turn the line is snapped at least this often: the providers' vertices are often 100–200 m apart on a
 * straight, and one of them snapped onto a stray link (or dropped) pulled the line diagonally across the road all
 * the way back to the last (into 1차로 before a right turn, 2026-10-11 17:52 and 14:00).
 */
const DENSE_M = 20;
/** Where the turn's lane is first asked for, the line moves over to it over this far, not in one step between two vertices. */
const RAMP_M = 40;
/** Before a turn, a vertex without a snap of its own (or with one passed over) takes the shift between the snaps either side up to this far apart, on the same road. */
const BIAS_GAP_M = 200;
/** Of two runs of snaps that disagree before a turn, one of at least MIN_RUN snaps is a lane of the road; one off the turn's side still beats a shorter one on it with this many times its snaps. */
const RUN_OUTWEIGHS = 3;
const MIN_RUN = 3;

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
 * Which lane each vertex was snapped toward and on which road: [biases] as asked of the server (-1 the turn's lane
 * on the left, +1 on the right, 0 a through lane), [pieces] a number that changes past each turn's guide — the
 * road in and the road out are different roads, and their snaps are not weighed against each other.
 */
export interface SnapSides { biases?: number[]; pieces?: number[] }

/**
 * [path] moved beside each vertex's snap where there is one and it agrees
 * with its neighbours (only sideways: a lane's nearest point to a vertex
 * on a bend lies metres ahead of or behind it, which would bunch the
 * vertices up); a vertex without one is moved between the nearest with
 * (or fixed) either way, fading out over BLEND_M past the last, so the
 * line slides onto the lanes and off them without a jog. [fixed] marks
 * vertices already on a lane (a threaded corner): they stay, and the
 * line slides onto them like onto a snapped one.
 *
 * Snaps are weighed against each other only on one road ([sides].pieces)
 * with one lane asked for ([sides].biases). Before a turn, of two runs of
 * snaps that disagree, a short one off the turn's side goes (the server was
 * asked for the turn's lane; the other found a stray link or a ramp), two
 * long ones both stay; elsewhere, of two neighbours that disagree, the one
 * nearer the line as drawn stays. A vertex passed over before a turn takes
 * the shift between the snaps either side, not the provider's line.
 */
export function applySnap(path: LonLat[], snapped: (LonLat | null)[], fixed: boolean[] = [], sides: SnapSides = {}): LonLat[] {
  const n = path.length;
  const headings = headingsOf(path);
  const along: number[] = [0];
  for (let i = 1; i < n; i++) along.push(along[i - 1] + metres(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]));
  const kx = 111_320 * Math.cos(((path[0]?.[1] ?? 0) * Math.PI) / 180), ky = 111_320;
  const bias = (i: number) => sides.biases?.[i] ?? 0;
  const piece = (i: number) => sides.pieces?.[i] ?? 0;
  const sameRoad = (i: number, j: number) => piece(i) === piece(j) && bias(i) === bias(j);
  const keep = snapped.map((s, i) => (s && !fixed[i] && Number.isFinite(headings[i]) ? s : null));
  // Where the turn's lane is first asked for on a road, the line moves over to it between the snaps either side of RAMP_M.
  for (let i = 1, start = -Infinity; i < n; i++) {
    if (!sameRoad(i, i - 1)) start = piece(i) === piece(i - 1) && bias(i) !== 0 ? along[i] : -Infinity;
    if (along[i] - start < RAMP_M) keep[i] = null;
  }
  const bendAt = (q: LonLat[], i: number): number => {
    let a = i - 1, b = i + 1;
    while (a >= 0 && metres(q[a][0], q[a][1], q[i][0], q[i][1]) < 0.3) a--;
    while (b < n && metres(q[b][0], q[b][1], q[i][0], q[i][1]) < 0.3) b++;
    if (a < 0 || b >= n) return 0;
    return Math.abs(((bearing(q[i][0], q[i][1], q[b][0], q[b][1]) - bearing(q[a][0], q[a][1], q[i][0], q[i][1]) + 540) % 360) - 180);
  };
  for (let round = 0; round <= KINK_ROUNDS; round++) {
    // Each snap's sideways part, in the route's frame there (+ to the right).
    const lateral = keep.map((s, i) => {
      if (!s) return NaN;
      const dx = (s[0] - path[i][0]) * kx, dy = (s[1] - path[i][1]) * ky, h = (headings[i] * Math.PI) / 180;
      return dx * Math.cos(h) - dy * Math.sin(h);
    });
    const agree = (i: number, j: number) => Math.abs(lateral[i] - lateral[j]) <= SLOPE * Math.abs(along[i] - along[j]) + SLOPE_TOL_M;
    const have = keep.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
    const drop = new Set<number>();
    // One out of step with both neighbours on its road (which agree) goes.
    for (let k = 1; k + 1 < have.length; k++) {
      const a = have[k - 1], i = have[k], b = have[k + 1];
      if (sameRoad(a, i) && sameRoad(i, b) && agree(a, b) && !agree(i, a) && !agree(i, b)) drop.add(i);
    }
    // Then road by road (the snaps of one road, one lane asked for). Where no turn is near, of two neighbours out of
    // step with each other the one further from the line as drawn goes. Before a turn, runs of snaps each in step
    // with the one before: of two side by side, a short one off the turn's side goes (it found a stray link, a ramp,
    // the middle of a road it read as narrower) — nearer the line was no sign of right there: the snap 14 m over
    // onto the right lane where the turn was lost to the ramp's next vertex 2 m over, and the line slid into 1차로
    // (2026-10-11 17:52). Two long runs both stay (a road widening, a lane added): the line steps between them.
    const roads: number[][] = [];
    for (const i of have) {
      if (drop.has(i)) continue;
      const road = roads[roads.length - 1];
      if (road && sameRoad(road[road.length - 1], i)) road.push(i); else roads.push([i]);
    }
    for (const road of roads) {
      const side = bias(road[0]);
      if (side === 0) {
        let last = -1;
        for (const i of road) {
          if (last < 0 || agree(last, i)) { last = i; continue; }
          if (Math.abs(lateral[i]) > Math.abs(lateral[last])) drop.add(i); else { drop.add(last); last = i; }
        }
        continue;
      }
      const runsOf = (ids: number[]) => {
        const runs: number[][] = [];
        for (const i of ids) {
          const run = runs[runs.length - 1];
          if (run && agree(run[run.length - 1], i)) run.push(i); else runs.push([i]);
        }
        return runs;
      };
      const mean = (run: number[]) => run.reduce((sum, i) => sum + lateral[i], 0) / run.length;
      /**
       * Of two runs side by side, the one that goes; null when both stay. A run of MIN_RUN snaps or more is a lane
       * the road has there (dropped, the line cut diagonally over the lanes from the snaps before to those after it):
       * it goes only against a run on the turn's side, and stays beside one; a shorter one on the turn's side goes
       * only beside a run of RUN_OUTWEIGHS times its snaps.
       */
      const loserOf = (a: number[], b: number[]): number[] | null => {
        if (a.length >= MIN_RUN && b.length >= MIN_RUN) return null;
        const [toward, other] = side * mean(a) >= side * mean(b) ? [a, b] : [b, a];
        if (other.length < MIN_RUN) return other;
        return other.length >= RUN_OUTWEIGHS * toward.length ? toward : null;
      };
      let ids = road;
      for (let runs = runsOf(ids); runs.length > 1; runs = runsOf(ids)) {
        let loser: number[] | null = null;
        for (let k = 0; k + 1 < runs.length; k++) {
          const l = loserOf(runs[k], runs[k + 1]);
          if (l && (!loser || l.length < loser.length)) loser = l;
        }
        if (!loser) break;
        const gone = new Set(loser);
        for (const i of gone) drop.add(i);
        ids = ids.filter((i) => !gone.has(i));
      }
    }
    for (const i of drop) keep[i] = null;
    const shift: (readonly [number, number] | null)[] = keep.map((s, i) => {
      if (!s) return fixed[i] ? ([0, 0] as const) : null;
      const h = (headings[i] * Math.PI) / 180;
      return [(lateral[i] * Math.cos(h)) / kx, (-lateral[i] * Math.sin(h)) / ky] as const;
    });
    const between = (i: number, before: number, after: number) => {
      const span = along[after] - along[before], t = span > 0 ? (along[i] - along[before]) / span : 0.5;
      return [shift[before]![0] + (shift[after]![0] - shift[before]![0]) * t, shift[before]![1] + (shift[after]![1] - shift[before]![1]) * t] as const;
    };
    const moved = path.map((p, i) => {
      if (shift[i]) return [p[0] + shift[i]![0], p[1] + shift[i]![1]] as LonLat;
      // Before a turn: between the snaps either side on this road, not back onto the provider's line.
      if (bias(i) !== 0) {
        let before = -1, after = -1;
        for (let j = i - 1; j >= 0 && along[i] - along[j] <= BIAS_GAP_M && piece(j) === piece(i); j--) if (shift[j]) { before = j; break; }
        for (let j = i + 1; j < n && along[j] - along[i] <= BIAS_GAP_M && piece(j) === piece(i); j++) if (shift[j]) { after = j; break; }
        if (before >= 0 && after >= 0 && along[after] - along[before] <= BIAS_GAP_M) {
          const [sx, sy] = between(i, before, after);
          return [p[0] + sx, p[1] + sy] as LonLat;
        }
      }
      let before: number | null = null, after: number | null = null;
      for (let j = i - 1; j >= 0 && along[i] - along[j] <= BLEND_M; j--) if (shift[j]) { before = j; break; }
      for (let j = i + 1; j < n && along[j] - along[i] <= BLEND_M; j++) if (shift[j]) { after = j; break; }
      if (before === null && after === null) return p;
      let sx: number, sy: number;
      if (before !== null && after !== null) [sx, sy] = between(i, before, after);
      else {
        const j = (before ?? after)!, share = 1 - Math.abs(along[i] - along[j]) / BLEND_M;
        sx = shift[j]![0] * share; sy = shift[j]![1] * share;
      }
      return [p[0] + sx, p[1] + sy] as LonLat;
    });
    // A bend the snapping made where the line as drawn had none or was gentle: that snap goes, and the line is laid again.
    const kinks: number[] = [];
    for (let i = 1; i + 1 < n; i++) {
      if (keep[i]) {
        const bm = bendAt(moved, i), bp = bendAt(path, i);
        if ((bm >= KINK_DEG && bp < KINK_DEG / 2) || (bm >= 45 && bm - bp >= 20)) kinks.push(i);
      }
    }
    if (kinks.length === 0 || round === KINK_ROUNDS) return moved;
    for (const i of kinks) keep[i] = null;
  }
  return path;
}

/**
 * The side each vertex's lane is taken on (server lanes.ts snap): -1 the leftmost, +1 the rightmost, 0 a through
 * lane — the lane the next turn wants, from BIAS_TOWN_M before it in town and BIAS_FAST_M on a motorway (where the
 * exit is said from 1 km and the lanes are changed early), as the car apps draw the line in the lane to be in. The
 * lane is asked for RAMP_M further back, so the line is over in it by then. In town 300 m, not 250: a turn's lane
 * is said 300 m out, and at 250 the line came over to it only 250 m out (from 210 m with the ramp), the first
 * stretch on a two-lane road in the wrong one (the drives of 2026-10-11: 76% of the last 300 m before the 26 turns
 * with lanes drawn in the turn's lane; 96% with this and the snaps weighed by the turn's side).
 */
const BIAS_TOWN_M = 300;
const BIAS_FAST_M = 600;
export interface BiasTurn { alongM: number; bias: number; reach: number }
/** The turns of [route] that want a lane on their side: where they are along [line], which side, and from how far before. */
export function biasTurns(route: Route, line = new Line(route.path)): BiasTurn[] {
  const turns: BiasTurn[] = [];
  if (!route.guides || route.path.length < 2) return turns;
  for (const g of route.guides) {
    const m = maneuverOf(route.provider, g);
    let bias = 0;
    if (m === "left" || m === "sharp-left" || m === "slight-left" || m === "ramp-left" || m === "uturn") bias = -1;
    else if (m === "right" || m === "sharp-right" || m === "slight-right" || m === "ramp-right") bias = 1;
    if (bias !== 0) {
      const p = line.project(g.at, 0, line.path.length);
      const fast = route.motorways?.some(([a, b]) => p.segment >= a && p.segment < b) ?? false;
      turns.push({ alongM: p.alongM, bias, reach: (fast ? BIAS_FAST_M : BIAS_TOWN_M) + RAMP_M });
    }
  }
  return turns.sort((a, b) => a.alongM - b.alongM);
}
/**
 * Out of a turn the line is in the lane the turn comes out in — the nearest on its side, the rightmost after a right
 * turn — for this far, before it moves over to the next turn's (RAMP_M). A right turn 163 m before a left one came out
 * straight into 1차로 of three, the corner bent into a hook (the pretend drive of 2026-10-11 at 노원구민체육센터앞):
 * the left turn's side reached back over the corner, and the change of road started no ramp.
 */
export const EXIT_M = 30;
/** Before the next turn the line is to be over in its lane by at least this, whatever is left between the two. */
const SETTLE_M = 20;
/**
 * Each vertex of [line]'s side and road (how many turns are behind it): just out of a turn its exit lane's side
 * (EXIT_M, shorter where the next turn is near, so the move to its lane still fits), then the next turn's within its
 * reach, else 0.
 */
export function sidesAlong(line: Line, turns: BiasTurn[]): Required<SnapSides> {
  const n = line.path.length;
  const biases = new Array<number>(n).fill(0), pieces = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const along = line.along[i];
    // The guide's own vertex (projected onto itself, give or take a rounding) is the road in's.
    pieces[i] = turns.filter((t) => t.alongM + 0.5 < along).length;
    const t = turns.find((t) => t.alongM - along >= -0.5 && t.alongM - along <= t.reach);
    const prev = [...turns].reverse().find((p) => p.alongM + 0.5 < along);
    if (prev) {
      const gap = t ? t.alongM - prev.alongM : Infinity;
      const exit = Math.max(0, Math.min(EXIT_M, gap - RAMP_M - SETTLE_M));
      if (along - prev.alongM <= exit + 0.5) { biases[i] = prev.bias; continue; }
    }
    if (t) biases[i] = t.bias;
  }
  return { biases, pieces };
}

/**
 * [path] with points put in along [stretches] (from, to along it, in metres) so that none there is further than
 * DENSE_M from the next, and one at each stretch's start; not between two [fixed] vertices (a threaded arc).
 * [map] takes each old index to its new one (map[n] the new length), for the indices into the path.
 */
export function densify(path: LonLat[], stretches: [number, number][], fixed: boolean[] = []): { path: LonLat[]; map: number[] } {
  const line = new Line(path);
  const out: LonLat[] = [];
  const map: number[] = [];
  for (let i = 0; i < path.length; i++) {
    map.push(out.length);
    out.push(path[i]);
    if (i + 1 >= path.length || (fixed[i] && fixed[i + 1])) continue;
    const a = line.along[i], b = line.along[i + 1], len = b - a;
    const cuts: number[] = [];
    for (const [s, e] of stretches) {
      const u = Math.max(a, s), v = Math.min(b, e);
      if (v <= u) continue;
      const k = Math.ceil((v - u) / DENSE_M);
      for (let j = 0; j <= k; j++) cuts.push(u + ((v - u) * j) / k);
    }
    let last = a;
    for (const c of cuts.sort((x, y) => x - y)) {
      if (c < last + 1 || c > b - 1) continue;
      const t = (c - a) / len;
      out.push([path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t]);
      last = c;
    }
  }
  map.push(out.length);
  return { path: out, map };
}

/** The server's snap (lanes.ts) of [points] with the route's [headings] there and the lane side each wants; null when it could not answer. */
export type Snapper = (points: LonLat[], headings: number[], biases: number[]) => Promise<(LonLat | null)[] | null>;

const askServer: Snapper = async (points, headings, biases) => {
  const out: (LonLat | null)[] = [];
  for (let i = 0; i < points.length; i += SNAP_BATCH) {
    const a = await fetch("/api/hdmap/snap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: points.slice(i, i + SNAP_BATCH), headings: headings.slice(i, i + SNAP_BATCH), biases: biases.slice(i, i + SNAP_BATCH) }),
    });
    if (!a.ok) return null;
    out.push(...((await a.json()) as { at: (LonLat | null)[] }).at);
  }
  return out;
};

/** [route] with its line on the travel-direction lanes wherever 정밀도로지도 has them; as it came elsewhere. */
export async function snapRoute(route: Route): Promise<Route> {
  return snapRouteWith(route, askServer);
}

/**
 * [snapRoute] with the lanes asked of [snap]. Before each turn the line gets a vertex every DENSE_M (the indices into
 * the path — congestion, motorways, threaded corners — moved with them), so each stretch is snapped where it is.
 */
export async function snapRouteWith(route: Route, snap: Snapper): Promise<Route> {
  try {
    const n0 = route.path.length;
    const turns = biasTurns(route);
    const fixed0: boolean[] = [];
    for (const [a, b] of route.threaded ?? []) for (let i = a; i < b; i++) fixed0[i] = true;
    // Dense before each turn (its lane's reach) and just after it (the exit lane and the move on to the next one's).
    const dense = densify(route.path, turns.flatMap((t) => [[t.alongM - t.reach - DENSE_M, t.alongM], [t.alongM, t.alongM + EXIT_M + RAMP_M + DENSE_M]] as [number, number][]), fixed0);
    const move = (i: number) => dense.map[Math.min(i, n0)];
    const threaded = (route.threaded ?? []).map(([a, b]) => [move(a), move(b)] as [number, number]);
    const fixed: boolean[] = [];
    for (const [a, b] of threaded) for (let i = a; i < b; i++) fixed[i] = true;
    const sides = sidesAlong(new Line(dense.path), turns);
    // A threaded corner is on its lane already: not asked about (a NaN heading comes back null).
    const headings = headingsOf(dense.path).map((h, i) => (fixed[i] ? NaN : h));
    const snapped = await snap(dense.path, headings, sides.biases);
    // Nothing to put the line on, or the route changed meanwhile: left as it is.
    if (!snapped || !snapped.some(Boolean) || route.path.length !== n0) return route;
    for (const seg of route.segments) { seg.from = move(seg.from); seg.to = move(seg.to); }
    if (route.motorways) route.motorways = route.motorways.map(([a, b]) => [move(a), move(b)] as [number, number]);
    if (route.threaded) route.threaded = threaded;
    route.path = applySnap(dense.path, snapped, fixed, sides);
  } catch { /* the line as the provider drew it */ }
  return route;
}

/** [route] with every corner the server can thread taken from the painted lanes; the route as it came where it cannot. */
export async function threadRoute(route: Route): Promise<Route> {
  try {
    const turns = turnsOf(route);
    if (turns.length === 0) { roundCorners(route); return route; }
    const a = await fetch("/api/hdmap/thread", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turns: turns.map((t) => t.turn) }) });
    if (!a.ok) return route;
    const { trails, alts } = (await a.json()) as { trails: (LonLat[] | null)[]; alts?: (LonLat[] | null)[] };
    // Each corner's first trail that fits the line: the stop line's, else the one from the lanes before it.
    trails.forEach((trail, i) => {
      const at = turns[i]?.turn.at;
      if (trail && splice(route, trail, at)) return;
      const alt = alts?.[i];
      if (alt) splice(route, alt, at);
    });
  } catch { /* the corners as the provider drew them */ }
  // What the lanes did not thread, rounded.
  try { roundCorners(route); } catch { /* left as drawn */ }
  return route;
}
