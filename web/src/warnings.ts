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
export type Kind = "speed" | "signal" | "speed-signal" | "section-start" | "section-end" | "bump" | "school" | "curve" | "other";

export interface Feature {
  id: string;
  kind: Kind;
  lon: number;
  lat: number;
  limit?: number;
  name?: string;
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
/** The distances at which each kind is spoken; a feature is spoken once per rung. */
export const RUNGS_M: Record<Kind, number[]> = {
  speed: [600, 300],
  signal: [600, 300],
  "speed-signal": [600, 300],
  "section-start": [600, 300],
  "section-end": [300],
  bump: [150],
  school: [300],
  curve: [200],
  other: [300],
};

export class RouteWatch {
  private line: Line;
  /** Every feature on the route, sorted by where it is along it. */
  private onRoute: { feature: Feature; alongM: number }[] = [];
  /** feature id → the rungs already spoken. */
  private spoken = new Map<string, Set<number>>();

  constructor(private route: Route) {
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
    if (p.offM > ON_ROUTE_M) return;
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
    for (const a of this.ahead(alongM, 700)) {
      const rungs = RUNGS_M[a.feature.kind];
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
}

/** Bearing change over this many metres counts as a bend, not a lane wobble. */
const CURVE_WINDOW_M = 40;
const CURVE_DEG = 35;
/** A bend within this far of a turn guide *is* the turn. */
const GUIDE_M = 60;

/**
 * Bends in the route: where the road's direction changes by more than
 * CURVE_DEG within CURVE_WINDOW_M, away from any turn guide (a turn is
 * announced already). One feature per bend, at its start.
 */
export function findCurves(route: Route): Feature[] {
  const line = new Line(route.path);
  const guidesAlong = route.guides.map((g) => line.project(g.at, 0, route.path.length).alongM);
  const out: Feature[] = [];
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
    lastBendAlong = at;
    const [lon, lat] = route.path[i];
    out.push({ id: `curve:${i}`, kind: "curve", lon, lat, name: `${Math.round(turn)}°` });
  }
  return out;
}

function segBearing(line: Line, i: number): number {
  const dx = line.xs[i + 1] - line.xs[i];
  const dy = line.ys[i + 1] - line.ys[i];
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** What the voice says for one due warning. Fixed phrases first: they are pre-rendered. */
export function phraseFor(w: Ahead & { rungM: number }): string {
  const d = `${w.rungM}미터 앞`;
  switch (w.feature.kind) {
    case "speed": return w.feature.limit ? `${d} 과속 단속, 제한 ${w.feature.limit}` : `${d} 과속 단속`;
    case "signal": return `${d} 신호 단속`;
    case "speed-signal": return w.feature.limit ? `${d} 신호 과속 단속, 제한 ${w.feature.limit}` : `${d} 신호 과속 단속`;
    case "section-start": return w.feature.limit ? `${d} 구간 단속 시작, 제한 ${w.feature.limit}` : `${d} 구간 단속 시작`;
    case "section-end": return `${d} 구간 단속 끝`;
    case "bump": return `${d} 과속 방지턱`;
    case "school": return `${d} 어린이 보호구역`;
    case "curve": return `${d} 급커브`;
    default: return `${d} 주의`;
  }
}

export function keyOf(at: LonLat): string {
  return `${at[0].toFixed(3)},${at[1].toFixed(3)}`;
}
