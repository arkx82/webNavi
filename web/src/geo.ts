/** Small flat-earth geometry: good to well under a metre over city distances. */
import type { LonLat } from "./types";

const M_PER_DEG = 111_320;

export function bearing(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function metres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const x = (lon2 - lon1) * M_PER_DEG * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const y = (lat2 - lat1) * M_PER_DEG;
  return Math.hypot(x, y);
}

/** Turns [from] toward [to] by [t] of the short way round. */
export function lerpAngle(from: number, to: number, t: number): number {
  let d = to - from;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return (from + d * t + 360) % 360;
}

/** Absolute difference between two bearings, 0..180. */
export function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** The point [m] metres from [from] along [bearingDeg]. */
export function offset(from: LonLat, bearingDeg: number, m: number): LonLat {
  const rad = (bearingDeg * Math.PI) / 180;
  const dy = (Math.cos(rad) * m) / M_PER_DEG;
  const dx = (Math.sin(rad) * m) / (M_PER_DEG * Math.cos((from[1] * Math.PI) / 180));
  return [from[0] + dx, from[1] + dy];
}

/**
 * A polyline in local metres, with its cumulative length, so a point can be
 * projected onto it and a distance along it turned back into a place.
 */
export class Line {
  /** x/y metres from the first vertex. */
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** Cumulative metres at each vertex. */
  readonly along: Float64Array;
  readonly lengthM: number;
  private readonly kx: number;

  constructor(readonly path: LonLat[]) {
    const n = path.length;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.along = new Float64Array(n);
    const [lon0, lat0] = path[0] ?? [0, 0];
    this.kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
    for (let i = 0; i < n; i++) {
      this.xs[i] = (path[i][0] - lon0) * this.kx;
      this.ys[i] = (path[i][1] - lat0) * M_PER_DEG;
      this.along[i] = i === 0 ? 0 : this.along[i - 1] + Math.hypot(this.xs[i] - this.xs[i - 1], this.ys[i] - this.ys[i - 1]);
    }
    this.lengthM = n ? this.along[n - 1] : 0;
  }

  private toXY(p: LonLat): [number, number] {
    return [(p[0] - this.path[0][0]) * this.kx, (p[1] - this.path[0][1]) * M_PER_DEG];
  }

  private toLonLat(x: number, y: number): LonLat {
    return [this.path[0][0] + x / this.kx, this.path[0][1] + y / M_PER_DEG];
  }

  /**
   * Nearest point on the line to [p]. Searched first within [window]
   * segments of [near] (the last match), then everywhere — a car does not
   * jump, and a route that loops past itself must not snap to the far pass.
   */
  project(p: LonLat, near = 0, window = 40): Projection {
    const n = this.path.length;
    if (n === 0) return { at: p, alongM: 0, offM: Infinity, segment: 0, bearing: 0 };
    const [px, py] = this.toXY(p);
    if (n === 1) return { at: this.path[0], alongM: 0, offM: Math.hypot(px - this.xs[0], py - this.ys[0]), segment: 0, bearing: 0 };
    let best = this.scan(px, py, Math.max(0, near - window), Math.min(n - 1, near + window));
    // Off the window by a lot: look again everywhere before believing it.
    if (best.offM > 60) {
      const all = this.scan(px, py, 0, n - 1);
      if (all.offM < best.offM - 5) best = all;
    }
    return best;
  }

  private scan(px: number, py: number, from: number, to: number): Projection {
    let bestD = Infinity, bestI = from, bestT = 0;
    for (let i = from; i < to; i++) {
      const ax = this.xs[i], ay = this.ys[i], bx = this.xs[i + 1], by = this.ys[i + 1];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const qx = ax + t * dx, qy = ay + t * dy;
      const d = Math.hypot(px - qx, py - qy);
      if (d < bestD) { bestD = d; bestI = i; bestT = t; }
    }
    return this.at(bestI, bestT, bestD);
  }

  private at(i: number, t: number, offM: number): Projection {
    const ax = this.xs[i], ay = this.ys[i], bx = this.xs[i + 1], by = this.ys[i + 1];
    const x = ax + t * (bx - ax), y = ay + t * (by - ay);
    const segLen = this.along[i + 1] - this.along[i];
    return {
      at: this.toLonLat(x, y),
      alongM: this.along[i] + t * segLen,
      offM,
      segment: i,
      bearing: ((Math.atan2(bx - ax, by - ay) * 180) / Math.PI + 360) % 360,
    };
  }

  /** The place [alongM] metres from the start, clamped to the line. */
  place(alongM: number): Projection {
    const n = this.path.length;
    if (n < 2) return { at: this.path[0] ?? [0, 0], alongM: 0, offM: 0, segment: 0, bearing: 0 };
    const m = Math.max(0, Math.min(this.lengthM, alongM));
    // Binary search the vertex before m.
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.along[mid] <= m) lo = mid; else hi = mid;
    }
    const segLen = this.along[lo + 1] - this.along[lo];
    const t = segLen === 0 ? 0 : (m - this.along[lo]) / segLen;
    return this.at(lo, t, 0);
  }

  /**
   * The sub-polyline between fromM and toM along this line, including exact
   * start/end positions and all route vertices strictly between them.
   */
  slice(fromM: number, toM: number): LonLat[] {
    const from = Math.max(0, Math.min(this.lengthM, fromM));
    const to = Math.max(from, Math.min(this.lengthM, toM));
    if (this.path.length < 2 || to <= from) return [];

    const startP = this.place(from);
    const endP = this.place(to);
    const out: LonLat[] = [startP.at];

    for (let i = startP.segment + 1; i <= endP.segment; i++) {
      if (this.along[i] > from && this.along[i] < to) {
        out.push(this.path[i]);
      }
    }
    out.push(endP.at);
    return out;
  }
}

export interface Projection {
  at: LonLat;
  /** Metres from the line's start. */
  alongM: number;
  /** Metres off the line. */
  offM: number;
  segment: number;
  /** Direction of the line here, degrees from north. */
  bearing: number;
}
