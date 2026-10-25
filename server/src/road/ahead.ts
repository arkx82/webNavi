import type { Fetch, LonLat } from "./limits.js";

/**
 * 안전운전 모드: the road in front of a car that has no route — the cameras, 구간 단속 and 보호구역 on it are warned of
 * as on a route (web/src/safe-drive.ts). There is no route to say which way the car goes at a junction, so the road is
 * taken on as it runs: our OSRM (표준노드링크) asked from the car's end of it to a point a short step straight on, step
 * after step, each from the last one's end and its heading. A short step bends with the road (a point 200 m on along a
 * curve is a few metres off it); at a junction the way on that is nearest straight is taken, as TMAP's 안전운전 does.
 */

/** Each step asked for this far straight on from the end so far; the next lengths if that way is not straight. */
export const AHEAD_STEP_M = 200;
const STEP_TRIES_M = [AHEAD_STEP_M, 320, 130, 480];
/** A step this little longer than straight is the road on: taken without trying more. */
const STRAIGHT = 1.25;
/** The longest road given, and the most steps it takes. */
export const AHEAD_MAX_M = 5000;
const MAX_STEPS = 30;
/** A step whose way is this much longer than from end to end went round (a U-turn, the other carriageway): the road stops there. */
const DETOUR = 1.8;
/** The car's own end snapped to a road this near, and only to one running its way. */
const CAR_RADIUS_M = 35;
const CAR_BEARING_DEG = 40;
/** Each later step from the end so far: on its road, running within this much of the heading there (a curve's end turns). */
const FROM_RADIUS_M = 10;
const FROM_BEARING_DEG = 45;
/** Where nothing is straight on: a step this long toward these turns off the heading, to find where the road bends. */
const BEND_STEP_M = 150;
const BEND_DEG = [-45, 45, -90, 90];
/** A step's end: on a road this near the point straight on, running within this much of the heading. */
const STEP_RADIUS_M = 80;
const STEP_BEARING_DEG = 70;
/** The heading at an end: over this much of the way back from it. */
const HEADING_OVER_M = 30;

const R = 6_371_000;
const RAD = Math.PI / 180;

export function metres(a: LonLat, b: LonLat): number {
  const k = Math.cos(((a[1] + b[1]) / 2) * RAD);
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * R * RAD;
}
export function bearing(a: LonLat, b: LonLat): number {
  const k = Math.cos(((a[1] + b[1]) / 2) * RAD);
  return (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) / RAD + 360) % 360;
}
function onFrom(p: LonLat, deg: number, m: number): LonLat {
  const k = Math.cos(p[1] * RAD);
  return [p[0] + (Math.sin(deg * RAD) * m) / (R * RAD * k), p[1] + (Math.cos(deg * RAD) * m) / (R * RAD)];
}
/** The heading the path ends with, over its last few tens of metres. */
function endHeading(path: LonLat[]): number {
  const end = path[path.length - 1];
  for (let i = path.length - 2; i >= 0; i--) if (metres(path[i], end) >= HEADING_OVER_M || i === 0) return bearing(path[i], end);
  return 0;
}

interface OsrmRoute {
  code?: string;
  routes?: {
    distance: number;
    geometry: { coordinates: LonLat[] };
    legs: { steps: { distance: number; maneuver?: { type: string; modifier?: string }; intersections?: { classes?: string[] }[] }[] }[];
  }[];
}

export interface RoadAhead {
  path: LonLat[];
  /** Index ranges into [path] on a motorway or car-only road, as a route's (route/osrm.ts). */
  motorways: [number, number][];
  lengthM: number;
}

type Way = NonNullable<OsrmRoute["routes"]>[number];
/** OSRM's maneuvers that leave the road: a turn at a junction, the road's end, a ramp, a roundabout. */
const LEAVING = new Set(["turn", "end of road", "fork", "on ramp", "off ramp", "roundabout", "rotary", "roundabout turn", "exit roundabout", "exit rotary"]);
/** Whether the way turns off at a junction (a slight fork or one straight on is the road going on). */
export function turnsOff(r: Way): boolean {
  return r.legs.some((l) => l.steps.some((s) => !!s.maneuver && LEAVING.has(s.maneuver.type) && !/straight|slight/.test(s.maneuver.modifier ?? "")));
}

/** The way [r] up to where it first turns off: its steps before that one, cut from its line by their length. */
export function upToTurn(r: Way): LonLat[] {
  let before = 0;
  outer: for (const l of r.legs) {
    for (const s of l.steps) {
      if (s.maneuver && LEAVING.has(s.maneuver.type) && !/straight|slight/.test(s.maneuver.modifier ?? "")) break outer;
      before += s.distance;
    }
  }
  const line = r.geometry.coordinates;
  const out: LonLat[] = [line[0]];
  let m = 0;
  for (let i = 1; i < line.length && m < before; i++) {
    const d = metres(line[i - 1], line[i]);
    if (m + d <= before) { out.push(line[i]); m += d; continue; }
    const t = (before - m) / d;
    out.push([line[i - 1][0] + t * (line[i][0] - line[i - 1][0]), line[i - 1][1] + t * (line[i][1] - line[i - 1][1])]);
    break;
  }
  return out;
}

/** The road ahead of a car at [at] heading [deg], [lengthM] long at most (shorter where it ends, forks round a bend or turns back). */
export async function roadAhead(base: string, at: LonLat, deg: number, lengthM: number, fetchJson: Fetch, trace?: (m: string) => void): Promise<RoadAhead | null> {
  const want = Math.min(AHEAD_MAX_M, Math.max(AHEAD_STEP_M, lengthM));
  const path: LonLat[] = [];
  const motorways: [number, number][] = [];
  let from = at, heading = deg, total = 0;
  /** The way from [from] to a point [len] on toward [aim]: how much longer than straight it runs, or why there is none. */
  const ask = async (aim: number, len: number, first: boolean): Promise<{ r: Way; ratio: number; turns: boolean } | { why: string; carOff?: boolean }> => {
    const to = onFrom(from, aim, len);
    const url = `${base}/route/v1/driving/${from[0].toFixed(6)},${from[1].toFixed(6)};${to[0].toFixed(6)},${to[1].toFixed(6)}`
      + `?overview=full&geometries=geojson&steps=true&continue_straight=true`
      + `&bearings=${Math.round(heading)},${first ? CAR_BEARING_DEG : FROM_BEARING_DEG};${Math.round(aim)},${STEP_BEARING_DEG}`
      + `&radiuses=${first ? CAR_RADIUS_M : FROM_RADIUS_M};${STEP_RADIUS_M}`;
    const a = await fetchJson(url);
    const j = (await a.json().catch(() => ({}))) as OsrmRoute & { message?: string };
    const r = j.code === "Ok" ? j.routes?.[0] : undefined;
    const line = r?.geometry.coordinates ?? [];
    if (!r || line.length < 2 || r.distance < 5) return { why: `${a.status} ${j.code ?? ""} ${j.message ?? ""}`, carOff: j.code === "NoSegment" && / 0$/.test(j.message ?? "") };
    return { r, ratio: r.distance / Math.max(1, metres(line[0], line[line.length - 1])), turns: turnsOff(r) };
  };
  /** [line] onto the path, its length back; marked a motorway where [r]'s road is classed so (a 고속국도 or its ramps). */
  const append = (line: LonLat[], r: Way, whole: boolean): number => {
    const start = path.length;
    for (const p of line) {
      const last = path[path.length - 1];
      if (!last || metres(last, p) > 0.5) path.push(p);
    }
    if (r.legs.some((l) => l.steps.some((s) => s.intersections?.some((i) => i.classes?.includes("motorway"))))) {
      const lastRange = motorways[motorways.length - 1];
      const a0 = Math.max(0, start - 1), b0 = path.length - 1;
      if (lastRange && lastRange[1] >= a0) lastRange[1] = b0; else motorways.push([a0, b0]);
    }
    if (whole) return r.distance;
    let m = 0;
    for (let i = 1; i < line.length; i++) m += metres(line[i - 1], line[i]);
    return m;
  };
  for (let step = 0; step < MAX_STEPS && total < want; step++) {
    const first = step === 0;
    // The point straight on can land on the wrong road past a junction — a slip road onto it that only a U-turn reaches
    // (강남대로 at 신논현, 2026-10-25), a side street's stub nearer it than the road bending on (영산로 by 청운로, 무안)
    // — so a few lengths are tried, and of the ways that do not turn off, the straightest taken.
    let best: { r: Way; ratio: number; turns: boolean } | null = null;
    let why = "";
    const better = (a: { ratio: number; turns: boolean }, b: { ratio: number; turns: boolean }) => (a.turns !== b.turns ? !a.turns : a.ratio < b.ratio);
    for (const len of STEP_TRIES_M) {
      const got = await ask(heading, len, first);
      if ("why" in got) {
        why = got.why;
        // The car's own end on no road its way: no other length will find one.
        if (got.carOff) break;
        continue;
      }
      if (!best || better(got, best)) best = got;
      if (got.ratio <= STRAIGHT && !got.turns) break;
      why = got.turns ? "turns off" : `round about ×${got.ratio.toFixed(2)}`;
    }
    // Only a turn off straight on: a junction the road ends at, and which way the car takes is not known. The road up to
    // it is the car's all the same (a signal camera stands at its stop line).
    if (best?.turns) {
      const upTo = upToTurn(best.r);
      if (upTo.length >= 2) total += append(upTo, best.r, false);
      trace?.(`step ${step}: the road ends at a junction`);
      break;
    }
    // Nothing straight on: a road that bends hard (무안's country roads, 2026-10-25) is followed round where it bends
    // one way only; a way off to either side is a junction, and which the car takes is not known.
    if (!best || best.ratio > DETOUR) {
      const sides: { r: Way; ratio: number; turns: boolean; side: number }[] = [];
      for (const turn of BEND_DEG) {
        const got = await ask(heading + turn, BEND_STEP_M, first);
        // A way that turns off at a junction is a junction's, not the road bending.
        if (!("why" in got) && got.ratio <= STRAIGHT) sides.push({ ...got, side: got.turns ? 0 : Math.sign(turn) });
      }
      const oneSide = sides.length > 0 && sides[0].side !== 0 && sides.every((c) => c.side === sides[0].side);
      if (!oneSide) { trace?.(`step ${step}: ${why}${sides.length ? " · both ways" : " · no bend"}`); break; }
      best = sides.reduce((a, b) => (b.ratio < a.ratio ? b : a));
      trace?.(`step ${step}: bends ${sides[0].side < 0 ? "left" : "right"}`);
    }
    total += append(best.r.geometry.coordinates, best.r, true);
    from = path[path.length - 1];
    heading = endHeading(path);
  }
  if (path.length < 2) return null;
  return { path, motorways, lengthM: total };
}
