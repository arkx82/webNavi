import { CAMERA_KINDS, WARNING_RUNGS_M, cameraRungs, warningPhrase } from "../../server/src/phrases";
import { Line, angleBetween } from "./geo";
import type { LonLat, Route } from "./types";

/**
 * What lies ahead on this road: the safety features the server found
 * near the car, kept only where they sit on the route and in front of
 * the car (which is the direction filter the public data cannot give —
 * a camera facing the other carriageway projects onto the route too, but
 * only one of a pair is "ahead" for long, and both are on the same road,
 * so a warning for it costs a driver nothing), plus bends worked out from
 * the route's own shape.
 */
export type Kind = "speed" | "signal" | "speed-signal" | "section-start" | "section-end" | "bump" | "school" | "curve" | "curves" | "accident" | "bike-accident" | "other";

export interface Feature {
  id: string;
  kind: Kind;
  lon: number;
  lat: number;
  limit?: number;
  name?: string;
  /** An area (an accident hotspot): on the route if the route passes within this of its centre. */
  radiusM?: number;
}

export interface Ahead {
  feature: Feature;
  /** Metres along the route from the start. */
  alongM: number;
  /** Metres between the car and it, along the road. */
  inM: number;
}

/** Features more than this far from the route are on another road. */
export const ON_ROUTE_M = 25;
/** The distances at which each kind is spoken (server/src/phrases.ts); a feature is spoken once per rung. */
export const RUNGS_M: Record<Kind, number[]> = WARNING_RUNGS_M;

/** What the driver asked for (guide-settings.ts): which kinds, and cameras from how far. */
export interface WatchPrefs {
  wants(kind: Kind): boolean;
  cameraFromM: number;
}
const ALL: WatchPrefs = { wants: () => true, cameraFromM: 600 };

export class RouteWatch {
  private line: Line;
  /** Every feature on the route, sorted by where it is along it. */
  private onRoute: { feature: Feature; alongM: number }[] = [];
  /**
   * @param spoken feature id → the rungs already spoken. Handed on from the
   *   last watch when the same trip is re-routed, so a camera said before the
   *   wrong turn is not said again after it.
   */
  constructor(private route: Route, private prefs: () => WatchPrefs = () => ALL, private spoken = new Map<string, Set<number>>()) {
    this.line = new Line(route.path);
    for (const c of findCurves(route)) this.place(c);
  }

  /** Takes the server's radius answer; features already known are left alone. */
  add(features: Feature[]) {
    const known = new Set(this.onRoute.map((f) => f.feature.id));
    for (const f of features) if (!known.has(f.id)) this.place(f);
  }

  private place(f: Feature) {
    const p = this.line.project([f.lon, f.lat], 0, this.line.path.length);
    if (p.offM > Math.max(ON_ROUTE_M, f.radiusM ?? 0)) return;
    this.onRoute.push({ feature: f, alongM: p.alongM });
    this.onRoute.sort((a, b) => a.alongM - b.alongM);
  }

  /** Everything ahead of [alongM] within [horizonM], nearest first. */
  ahead(alongM: number, horizonM = 1000): Ahead[] {
    const out: Ahead[] = [];
    for (const f of this.onRoute) {
      const inM = f.alongM - alongM;
      if (inM < -10) continue;
      if (inM > horizonM) break;
      out.push({ feature: f.feature, alongM: f.alongM, inM });
    }
    return out;
  }

  /**
   * The warnings due now: features whose next rung the car has just
   * crossed. Each rung fires once; a re-route makes a new watch.
   */
  due(alongM: number): (Ahead & { rungM: number })[] {
    const out: (Ahead & { rungM: number })[] = [];
    const prefs = this.prefs();
    for (const a of this.ahead(alongM, 1100)) {
      if (!prefs.wants(a.feature.kind)) continue;
      const rungs = this.rungsOf(a.feature.kind, prefs);
      const done = this.spoken.get(a.feature.id) ?? new Set<number>();
      for (const rung of rungs) {
        if (done.has(rung) || a.inM > rung) continue;
        done.add(rung);
        this.spoken.set(a.feature.id, done);
        out.push({ ...a, rungM: rung });
        break; // one rung per feature per call; the next comes on a later call
      }
    }
    return out;
  }

  private rungsOf(kind: Kind, prefs: WatchPrefs): number[] {
    return CAMERA_KINDS.includes(kind) ? cameraRungs(prefs.cameraFromM) : RUNGS_M[kind];
  }

  /**
   * The limit the car is held to at [alongM], if any: inside a 구간 단속
   * (past its start, before its end), or with a camera that has a limit
   * ahead within the distance its warning starts at — the stretches where
   * the car apps turn the speed red. Null where no camera says.
   */
  limitAt(alongM: number): { limit: number; why: "section" | "camera"; inM?: number } | null {
    let section: number | null = null;
    for (const f of this.onRoute) {
      if (f.alongM > alongM) break;
      if (f.feature.kind === "section-start" && f.feature.limit) section = f.feature.limit;
      if (f.feature.kind === "section-end") section = null;
    }
    const from = this.prefs().cameraFromM;
    let camera: { limit: number; inM: number } | null = null;
    for (const a of this.ahead(alongM, from)) {
      const k = a.feature.kind;
      if (a.feature.limit && (k === "speed" || k === "speed-signal" || k === "school" || k === "section-start")) {
        camera = { limit: a.feature.limit, inM: a.inM };
        break;
      }
    }
    if (section != null && (!camera || section <= camera.limit)) return { limit: section, why: "section" };
    return camera ? { limit: camera.limit, why: "camera", inM: camera.inM } : null;
  }
}

/** Bearing change over this many metres counts as a bend, not a lane wobble. */
const CURVE_WINDOW_M = 40;
const CURVE_DEG = 35;
/** A bend within this far of a turn guide *is* the turn. */
const GUIDE_M = 60;
/**
 * A change made almost all at one vertex is a kink where two ways meet (a
 * junction, a road that jogs), not a bend: a real one is drawn as an arc.
 */
const KINK_SHARE = 0.8;
/** Bends closer together than this are one winding stretch, said once. */
export const CURVE_MERGE_M = 500;

/**
 * Bends in the route: where the road's direction changes by more than
 * CURVE_DEG within CURVE_WINDOW_M, spread over the arc rather than at one
 * vertex, away from any turn guide (a turn is announced already). A run of
 * bends each within CURVE_MERGE_M of the last becomes one "curves" feature
 * at its start — 연속 급커브, once — so a winding road is not a warning
 * every hundred metres.
 */
export function findCurves(route: Route): Feature[] {
  const line = new Line(route.path);
  const guidesAlong = route.guides.map((g) => line.project(g.at, 0, route.path.length).alongM);
  const bends: { i: number; along: number; turn: number }[] = [];
  let lastBendAlong = -Infinity;
  const n = route.path.length;
  for (let i = 1; i < n - 1; i++) {
    // The bearing into vertex i, and out of the vertex CURVE_WINDOW_M on.
    const bIn = segBearing(line, i - 1);
    let j = i;
    while (j < n - 1 && line.along[j] - line.along[i] < CURVE_WINDOW_M) j++;
    if (j >= n - 1) break;
    const bOut = segBearing(line, j);
    const turn = angleBetween(bIn, bOut);
    if (turn < CURVE_DEG) continue;
    const at = line.along[i];
    if (at - lastBendAlong < CURVE_WINDOW_M * 2) continue;
    if (guidesAlong.some((g) => Math.abs(g - at) < GUIDE_M)) continue;
    // The sharpest single vertex in the window: if it carries nearly all of the change, a kink.
    let sharpest = 0;
    for (let k = i; k <= j; k++) sharpest = Math.max(sharpest, angleBetween(segBearing(line, k - 1), segBearing(line, k)));
    if (sharpest >= turn * KINK_SHARE) continue;
    lastBendAlong = at;
    bends.push({ i, along: at, turn });
  }
  const out: Feature[] = [];
  for (let k = 0; k < bends.length; ) {
    let end = k;
    while (end + 1 < bends.length && bends[end + 1].along - bends[end].along < CURVE_MERGE_M) end++;
    const first = bends[k];
    const [lon, lat] = route.path[first.i];
    const many = end > k;
    out.push({ id: `curve:${first.i}`, kind: many ? "curves" : "curve", lon, lat, name: many ? `${end - k + 1}곳` : `${Math.round(first.turn)}°` });
    k = end + 1;
  }
  return out;
}

function segBearing(line: Line, i: number): number {
  const dx = line.xs[i + 1] - line.xs[i];
  const dy = line.ys[i + 1] - line.ys[i];
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** What the voice says for one due warning: a fixed sentence (server/src/phrases.ts), rendered ahead of time. */
export function phraseFor(w: Ahead & { rungM: number }): string {
  return warningPhrase(w.feature.kind, w.rungM, w.feature.limit);
}

export function keyOf(at: LonLat): string {
  return `${at[0].toFixed(3)},${at[1].toFixed(3)}`;
}
