import { korean } from "./osrm.js";
import type { Guide, LonLat, Route } from "./types.js";

/**
 * The turns a provider drew and did not say, said. 카카오 drew a left at a
 * T-junction in 중계동 (370 m from the start) with no guide for it: the line
 * on the map turned left while the panel and the voice gave the right turn
 * after it, so a driver going by the guide went straight on.
 *
 * A corner in the line is not always a turn, though — a mountain road bends
 * 80° with no junction, and no car app speaks there. So each corner of the
 * line with no guide near it is asked of our own OSRM (표준노드링크): a short
 * route across it, and whether OSRM makes a manoeuvre of it (it does at a
 * junction where the way turns, not where the road just bends). Only when
 * OSRM's way is the provider's own — the same corner, the same side — is
 * the guide put in, in OSRM's words ("한글비석로5길 방면 좌회전").
 */

/** A corner this sharp over 50 m (the 20 m either side of it) … */
const CORNER_DEG = 40;
/** … and this sharp within 10 m of its point, as a junction is drawn (a bend is spread along the road). */
const CORNER_SHARP_DEG = 25;
/** A guide of the provider's this near is the corner's own … */
const SAID_WITHIN_M = 60;
/** … and one to the same side this far before it (카카오 puts a guide at times 66 m short of its corner). */
const SAID_EARLY_M = 120;
/** A roundabout's ring is all corners, and its guide ("회전교차로", TMAP's "12시 방향") says them: none is asked this near one. */
const RING_M = 150;
/** The route asked of OSRM: from this far before the corner to this far after. */
const ACROSS_M = 40;
/** OSRM's manoeuvre has to be this near the corner, and its way this near the provider's line. */
const SAME_PLACE_M = 25;
const SAME_WAY_M = 15;
/** At most so many corners asked of one route (a mountain road has dozens; they are bends). */
const MOST_ASKED = 40;
const ASK_TIMEOUT_MS = 2000;

const R = 6371008.8;
const rad = Math.PI / 180;

/** Metres between two points (equirectangular: corners are tens of metres). */
function metres(a: LonLat, b: LonLat): number {
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = (b[1] - a[1]) * rad;
  return Math.hypot(x, y) * R;
}

function bearing(a: LonLat, b: LonLat): number {
  const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = b[1] - a[1];
  return ((Math.atan2(x, y) / rad) + 360) % 360;
}

/** A path measured along: the point at a distance, and the distance at a point. */
class Along {
  readonly at: number[] = [0];
  readonly lengthM: number;
  constructor(readonly path: LonLat[]) {
    for (let i = 1; i < path.length; i++) this.at.push(this.at[i - 1] + metres(path[i - 1], path[i]));
    this.lengthM = this.at[this.at.length - 1] ?? 0;
  }
  /** The point [m] along, and the index of the segment it is on. */
  place(m: number): { p: LonLat; segment: number } {
    const d = Math.max(0, Math.min(this.lengthM, m));
    let lo = 0, hi = this.at.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.at[mid] <= d) lo = mid;
      else hi = mid;
    }
    const span = this.at[hi] - this.at[lo];
    const f = span > 0 ? (d - this.at[lo]) / span : 0;
    const a = this.path[lo], b = this.path[hi] ?? a;
    return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], segment: lo };
  }
  /** How far along the point nearest [p] is, and how far off the path [p] is. */
  nearest(p: LonLat): { m: number; offM: number } {
    let best = { m: 0, offM: Infinity };
    for (let i = 0; i + 1 < this.path.length; i++) {
      const a = this.path[i], b = this.path[i + 1];
      const kx = Math.cos(a[1] * rad);
      const dx = (b[0] - a[0]) * kx, dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, (((p[0] - a[0]) * kx) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
      const q: LonLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const off = metres(p, q);
      if (off < best.offM) best = { m: this.at[i] + t * (this.at[i + 1] - this.at[i]), offM: off };
    }
    return best;
  }
}

const turnOf = (from: number, to: number) => ((to - from + 540) % 360) - 180;

export interface Corner {
  /** Metres along the route. */
  m: number;
  at: LonLat;
  /** Degrees, + to the right. */
  deg: number;
}

/** The side a guide's words turn to: 1 right, -1 left, 0 neither ("직진", "12시 방향"). */
export function sideOf(text: string): number {
  const hour = /(\d+)시 방향/.exec(text);
  if (hour) {
    const h = Number(hour[1]) % 12;
    return h >= 1 && h <= 5 ? 1 : h >= 7 ? -1 : 0;
  }
  if (/우회전|오른쪽|우측|P턴/.test(text)) return 1;
  if (/좌회전|왼쪽|좌측|유턴/.test(text)) return -1;
  return 0;
}

/** The corners of the route's line no guide of the provider's is at, off the motorways. */
export function cornersUnsaid(route: Route): Corner[] {
  const line = new Along(route.path);
  if (line.lengthM < 100) return [];
  const said = route.guides.map((g) => ({ m: line.nearest(g.at).m, side: sideOf(g.text), ring: /회전교차로|로터리|\d+시 방향/.test(g.text) }));
  const way = (from: number, to: number) => bearing(line.place(from).p, line.place(to).p);
  const turn = (m: number, near: number, far: number) => turnOf(way(m - far, m - near), way(m + near, m + far));
  const onMotorway = (m: number) => {
    const i = line.place(m).segment;
    return route.motorways?.some(([from, to]) => i >= from && i < to) ?? false;
  };
  const out: Corner[] = [];
  for (let m = 30; m < line.lengthM - 30; m += 3) {
    const t = turn(m, 5, 25);
    if (Math.abs(t) < CORNER_DEG || Math.abs(t) > 160 || Math.abs(turn(m, 1, 10)) < CORNER_SHARP_DEG) continue;
    // The sharpest point of this corner, not the first one past the bar.
    let best = m;
    for (let n = m + 1; n < m + 15 && n < line.lengthM - 30; n++) if (Math.abs(turn(n, 5, 25)) > Math.abs(turn(best, 5, 25))) best = n;
    m = best + SAID_WITHIN_M / 2;
    if (onMotorway(best) || said.some((s) => Math.abs(s.m - best) < SAID_WITHIN_M || (s.m < best && best - s.m < SAID_EARLY_M && s.side === Math.sign(turn(best, 5, 25))) || (s.ring && Math.abs(s.m - best) < RING_M))) continue;
    out.push({ m: best, at: line.place(best).p, deg: turn(best, 5, 25) });
  }
  return out;
}

interface OsrmStep {
  name?: string;
  maneuver: { location: LonLat; type: string; modifier?: string };
}
interface OsrmAcross {
  code?: string;
  routes?: { distance: number; geometry: { coordinates: LonLat[] }; legs: { steps: OsrmStep[] }[] }[];
}

/** OSRM's guide for [corner], if OSRM turns there the way the route does; else null. */
async function confirm(base: string, line: Along, corner: Corner): Promise<Guide | null> {
  const from = line.place(corner.m - ACROSS_M).p, to = line.place(corner.m + ACROSS_M).p;
  const url = `${base}/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}?steps=true&overview=full&geometries=geojson`;
  let answer: OsrmAcross;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ASK_TIMEOUT_MS) });
    if (!res.ok) return null;
    answer = (await res.json()) as OsrmAcross;
  } catch {
    return null;
  }
  const r = answer.routes?.[0];
  if (!r) return null;
  // OSRM's way has to be the provider's: about as long, and on its line all along (not round a one-way block).
  const ours = Math.min(line.lengthM, corner.m + ACROSS_M) - Math.max(0, corner.m - ACROSS_M);
  if (r.distance < ours * 0.75 || r.distance > ours * 1.3) return null;
  if (r.geometry.coordinates.some((p) => line.nearest(p).offM > SAME_WAY_M)) return null;
  const step = r.legs
    .flatMap((l) => l.steps)
    .find((s) => s.maneuver.type !== "depart" && s.maneuver.type !== "arrive" && metres(s.maneuver.location, corner.at) <= SAME_PLACE_M);
  const modifier = step?.maneuver.modifier ?? "";
  if (!step || !/left|right/.test(modifier) || /slight/.test(modifier) && Math.abs(corner.deg) < 60) return null;
  if (modifier.includes("right") !== corner.deg > 0) return null;
  const text = korean(step.maneuver.type, modifier, undefined, step.name || undefined);
  if (/직진|합류|진입/.test(text)) return null;
  return { at: corner.at, text, distanceM: 0, turnType: `missed:${step.maneuver.type}/${modifier}` };
}

/**
 * [route] with the turns its provider left unsaid put in among its guides,
 * each before the first of the provider's own past it (theirs keep their
 * order; their distanceM, which each reads its own way, as they were).
 * The number put in.
 */
export async function sayMissedTurns(route: Route, osrmBase: string): Promise<number> {
  if (route.path.length < 3) return 0;
  const corners = cornersUnsaid(route).slice(0, MOST_ASKED);
  if (!corners.length) return 0;
  const line = new Along(route.path);
  const found = (await Promise.all(corners.map((c) => confirm(osrmBase, line, c).then((g) => (g ? { g, m: c.m } : null))))).filter((x) => !!x);
  if (!found.length) return 0;
  const at = route.guides.map((g) => line.nearest(g.at).m);
  for (const { g, m } of found) {
    let i = at.findIndex((a) => a > m);
    if (i < 0) i = at.length;
    route.guides.splice(i, 0, g);
    at.splice(i, 0, m);
  }
  return found.length;
}
