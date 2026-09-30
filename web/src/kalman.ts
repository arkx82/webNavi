import type { LonLat } from "./types";

/**
 * A constant-velocity Kalman filter for the browser's fixes: position and
 * velocity in metres on a local plane, each fix a measurement trusted as
 * far as its own accuracy says. The car does not jump, so a fix 20 m off
 * the line of the last few pulls the estimate only part way; standing
 * still, the wander averages out instead of making a speed. The route
 * snapping (tracker.ts) comes after, on the smoothed fix.
 */
const M = 111_320;
/** How hard a car can change its speed, m/s² (the filter's trust in its own prediction). */
const ACCEL = 2.5;
/** A jump this far, or a gap this long, starts the filter afresh (a tunnel's end, a replay's start). */
const RESET_M = 200;
const RESET_S = 10;
/** A fix whose accuracy the browser could not give (Infinity, NaN) counts as this vague. */
const ACC_UNKNOWN_M = 1000;

export interface Filtered {
  at: LonLat;
  /** m/s, and degrees from north, from the filter's velocity. */
  speed: number;
  course: number | null;
}

export class Kalman {
  private origin: LonLat | null = null;
  private kx = 1;
  /** State x, y, vx, vy and its covariance, row-major 4×4. */
  private s = [0, 0, 0, 0];
  private P = new Array(16).fill(0);
  private t = 0;

  step(at: LonLat, accM: number, tMs: number): Filtered {
    // A place or a time that is not a number cannot be filtered: the last estimate stands (a state
    // gone NaN would never reset, since the jump test below is then a NaN comparison, always false).
    if (!Number.isFinite(at[0]) || !Number.isFinite(at[1]) || !Number.isFinite(tMs)) return this.origin ? this.out() : { at, speed: 0, course: null };
    if (!Number.isFinite(accM)) accM = ACC_UNKNOWN_M;
    const [mx, my] = this.toXY(at);
    const dt = (tMs - this.t) / 1000;
    const r = Math.max(3, accM) ** 2;
    if (!this.origin || !this.finite() || dt <= 0 || dt > RESET_S || Math.hypot(mx - this.s[0], my - this.s[1]) > RESET_M + accM) return this.reset(at, accM, tMs);
    this.t = tMs;
    // Predict: x += v dt, with the acceleration's noise.
    const [x, y, vx, vy] = this.s;
    this.s = [x + vx * dt, y + vy * dt, vx, vy];
    const F = [1, 0, dt, 0, 0, 1, 0, dt, 0, 0, 1, 0, 0, 0, 0, 1];
    const q = ACCEL * ACCEL, dt2 = dt * dt, dt3 = dt2 * dt / 2, dt4 = dt2 * dt2 / 4;
    const Q = [dt4 * q, 0, dt3 * q, 0, 0, dt4 * q, 0, dt3 * q, dt3 * q, 0, dt2 * q, 0, 0, dt3 * q, 0, dt2 * q];
    this.P = add(mul(mul(F, this.P), transpose(F)), Q);
    // Update with the fix (position only): K = P Hᵀ (H P Hᵀ + R)⁻¹, H picking x and y.
    const [p00, p01, p10, p11] = [this.P[0], this.P[1], this.P[4], this.P[5]];
    const a = p00 + r, b = p01, c = p10, d = p11 + r, det = a * d - b * c;
    const inv = [d / det, -b / det, -c / det, a / det];
    const K: number[] = [];
    for (let i = 0; i < 4; i++) {
      const pi0 = this.P[i * 4], pi1 = this.P[i * 4 + 1];
      K.push(pi0 * inv[0] + pi1 * inv[2], pi0 * inv[1] + pi1 * inv[3]);
    }
    const ex = mx - this.s[0], ey = my - this.s[1];
    this.s = this.s.map((v, i) => v + K[i * 2] * ex + K[i * 2 + 1] * ey);
    const KH = new Array(16).fill(0);
    for (let i = 0; i < 4; i++) { KH[i * 4] = K[i * 2]; KH[i * 4 + 1] = K[i * 2 + 1]; }
    this.P = mul(sub(identity(), KH), this.P);
    // Whatever the arithmetic did (a singular update), a state that is not a number starts afresh.
    if (!this.finite()) return this.reset(at, accM, tMs);
    return this.out();
  }

  private finite(): boolean {
    return this.s.every(Number.isFinite) && this.P.every(Number.isFinite);
  }

  private reset(at: LonLat, accM: number, tMs: number): Filtered {
    this.origin = at;
    this.kx = M * Math.cos((at[1] * Math.PI) / 180);
    this.s = [0, 0, 0, 0];
    const r = Math.max(3, accM) ** 2;
    this.P = [r, 0, 0, 0, 0, r, 0, 0, 0, 0, 100, 0, 0, 0, 0, 100];
    this.t = tMs;
    return this.out();
  }

  private out(): Filtered {
    const [x, y, vx, vy] = this.s;
    const speed = Math.hypot(vx, vy);
    return {
      at: [this.origin![0] + x / this.kx, this.origin![1] + y / M],
      speed,
      course: speed > 1.5 ? ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360 : null,
    };
  }

  private toXY(p: LonLat): [number, number] {
    if (!this.origin) return [0, 0];
    return [(p[0] - this.origin[0]) * this.kx, (p[1] - this.origin[1]) * M];
  }
}

function mul(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
  return o;
}
const transpose = (a: number[]) => a.map((_, n) => a[(n % 4) * 4 + Math.floor(n / 4)]);
const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);
const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
