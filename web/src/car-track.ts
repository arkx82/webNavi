/**
 * The car's own word on how far it went: its speed and odometer, from the
 * car's streaming (server car/, over /api/car/stream), so a tunnel where
 * the fixes stop is crossed at the pace the car really went — a jam inside
 * it stands the marker still, not carried on at the speed it went in at.
 *
 * Samples carry the car's own time. Whatever the link's delay, the
 * distance between two moments is the car's, not ours: the speed held
 * between samples (the telemetry sends a value only when it changes) and,
 * where the odometer is fine enough to be read in metres, the odometer
 * itself. A sample late or missed corrects itself when the rest comes.
 */
export interface CarSample {
  /** ms since 1970, the car's clock. */
  t: number;
  /** m/s; null in P (the car says nothing then), undefined when this sample does not carry it. */
  speedMps?: number | null;
  /** Metres. */
  odoM?: number | null;
  /** The odometer's resolution in metres, as the server read it off the car's own figures (0.1 mile is 161). */
  odoResM?: number | null;
  /** The car's own estimate of where it is, when it gives one: kept for the record. */
  est?: { lon: number; lat: number; heading: number | null } | null;
  /** "P", "R", "N", "D"; null when the car leaves it blank (parked, asleep); undefined when this sample does not carry it. */
  gear?: "P" | "R" | "N" | "D" | null;
}

/** Past the last sample the speed is held this long; beyond it the answer stops, and the caller goes on its own way. */
export const HOLD_MS = 4_000;
/** An odometer this fine or finer is read for the distance; a coarser one (0.1 mile) only the speed is. */
export const ODO_FINE_M = 10;
/** Kept this far back: a long tunnel and some. */
const KEEP_MS = 40 * 60_000;
/** The car's clock and ours this far apart is a clock gone wrong, not a delay: put right. */
const SKEW_MS = 5_000;
/** "Parked" is believed this long after the car last said anything; past it the link may be gone, and the car with it. */
export const PARKED_FRESH_MS = 60_000;

interface Point { t: number; v: number }
/** The car's own idea of where it is, and which way it points (degrees from north; null when it does not say). */
interface Est { t: number; lon: number; lat: number; heading: number | null }

/** Off the road (no route, or off it), the way the car went: metres east and north of where the last fix put it. */
export interface FreePath {
  dE: number;
  dN: number;
  heading: number | null;
  through: number;
  /** "est": the car's own estimate kept moving with it; "heading": its heading turned while the fixes were gone. */
  by: "est" | "heading";
}

const M_PER_DEG = 111_320;
/** Steps of the sum along a turning heading, ms. */
const STEP_MS = 500;

export class CarTrack {
  private speeds: Point[] = [];
  private odos: Point[] = [];
  private lastT = -Infinity;
  /** The odometer's resolution, metres, as last said. */
  private resM = Infinity;
  /** Times the odometer ran backwards: one that does is not believed. */
  private oddSteps = 0;
  /** Ours minus the car's, the smallest seen lately (the link's quickest delivery). */
  private skewMs: number | null = null;
  private ests: Est[] = [];
  lastEst: CarSample["est"] = null;
  lastEstAt = 0;
  /** In P (or the gear blank with no speed, as the owner streaming has it parked), as of [parkT] by the car's clock. */
  private park = false;
  private parkT = -Infinity;

  /** A sample in, as it came; [arrivedAt] our clock when it did. Out of order and repeated (a resend) is fine. */
  add(s: CarSample, arrivedAt = Date.now()) {
    if (!Number.isFinite(s.t)) return;
    const gap = arrivedAt - s.t;
    this.skewMs = this.skewMs == null ? gap : Math.min(gap, this.skewMs + 50);
    if (s.speedMps !== undefined) insert(this.speeds, { t: s.t, v: s.speedMps == null || !Number.isFinite(s.speedMps) ? 0 : Math.max(0, s.speedMps) });
    if (s.odoM != null && Number.isFinite(s.odoM)) {
      const i = insert(this.odos, { t: s.t, v: s.odoM });
      const prev = this.odos[i - 1];
      if (prev && this.odos[i].v - prev.v < -1) this.oddSteps++;
    }
    if (s.odoResM != null && Number.isFinite(s.odoResM)) this.resM = s.odoResM;
    if (s.t >= this.parkT) {
      if (s.gear !== undefined) { this.park = s.gear === "P" || (s.gear === null && s.speedMps === null); this.parkT = s.t; }
      // Whatever the gear last said, a car that goes is not parked.
      if (s.speedMps != null && s.speedMps > 0.5) { this.park = false; this.parkT = s.t; }
    }
    if (s.est && Number.isFinite(s.est.lon) && Number.isFinite(s.est.lat)) {
      this.lastEst = s.est;
      this.lastEstAt = s.t;
      const e: Est = { t: s.t, lon: s.est.lon, lat: s.est.lat, heading: s.est.heading != null && Number.isFinite(s.est.heading) ? s.est.heading : null };
      const i = upperT(this.ests, s.t);
      if (i > 0 && this.ests[i - 1].t === s.t) this.ests[i - 1] = e;
      else this.ests.splice(i, 0, e);
    }
    this.lastT = Math.max(this.lastT, s.t);
    const before = this.lastT - KEEP_MS;
    while (this.speeds.length > 2 && this.speeds[1].t < before) this.speeds.shift();
    while (this.odos.length > 2 && this.odos[1].t < before) this.odos.shift();
    while (this.ests.length > 2 && this.ests[1].t < before) this.ests.shift();
  }

  clear() {
    this.speeds = [];
    this.odos = [];
    this.lastT = -Infinity;
    this.resM = Infinity;
    this.oddSteps = 0;
    this.skewMs = null;
    this.ests = [];
    this.lastEst = null;
    this.park = false;
    this.parkT = -Infinity;
  }

  /** The car says it is parked, and said so lately (by [now], our clock): it is not going anywhere, whatever the fixes say. */
  parked(now = Date.now()): boolean {
    const at = this.lastAt;
    return this.park && at != null && now - at < PARKED_FRESH_MS;
  }

  /** Our clock in the car's: the same unless the two are seconds apart. */
  private carTime(t: number): number {
    return this.skewMs != null && Math.abs(this.skewMs) > SKEW_MS ? t - this.skewMs : t;
  }

  /** Whether the odometer is read in metres (fine enough, and it never ran backwards). */
  get odoFine(): boolean {
    return this.odos.length >= 2 && this.resM <= ODO_FINE_M && this.oddSteps === 0;
  }

  /** The car's last word, in our clock (null before any): how stale the link is. */
  get lastAt(): number | null {
    if (!Number.isFinite(this.lastT)) return null;
    return this.skewMs != null && Math.abs(this.skewMs) > SKEW_MS ? this.lastT + this.skewMs : this.lastT;
  }

  /** The speed it last said, m/s; null if it never did. */
  lastSpeed(): number | null {
    return this.speeds.length ? this.speeds[this.speeds.length - 1].v : null;
  }

  /**
   * Metres the car went from [t1] to [t2] (our clock), and the moment the
   * answer is good through: [t2], or sooner where the samples stop (the
   * link gone) — the rest is the caller's to guess. Null when there is
   * nothing from the car around [t1]: no telemetry, or none of late.
   */
  between(t1: number, t2: number): { m: number; through: number } | null {
    if (!this.speeds.length) return null;
    const a = this.carTime(t1), b = this.carTime(t2);
    // From before what is kept, or from after the samples had stopped: not the car's to say.
    if (a < this.speeds[0].t - 2_000 || a > this.lastT + HOLD_MS) return null;
    const end = Math.max(a, Math.min(b, this.lastT + HOLD_MS));
    const m = this.odoFine && this.odoAt(a) != null ? this.odoAt(end)! - this.odoAt(a)! : this.integral(a, end);
    return { m: Math.max(0, m), through: t1 + (end - a) };
  }

  /**
   * Off the road, from [t1] to [t2] (our clock): which way and how far the
   * car went, only where the car's own figures show they still live with
   * the fixes gone — its estimated place moving with it (then that place's
   * change is the answer), or else its heading turning (then the speed is
   * summed along it). A heading that never moved may be one that froze with
   * the GPS, and a straight line on it would carry the car off through the
   * walls: null, and the car is held where it was. From the stream's first
   * sample when it was opened after the fixes stopped.
   */
  freePath(t1: number, t2: number): FreePath | null {
    if (!this.speeds.length) return null;
    const b = this.carTime(t2);
    const a = Math.max(this.carTime(t1), this.speeds[0].t);
    if (a > this.lastT + HOLD_MS) return null;
    const end = Math.max(a, Math.min(b, this.lastT + HOLD_MS));
    const through = t2 - (b - end);
    const moved = this.integral(a, end);
    // Standing (or all but): nowhere to go, whatever the rest says.
    if (moved < 1) return { dE: 0, dN: 0, heading: this.headingAt(end), through, by: "heading" };
    const inside = this.ests.filter((e) => e.t > a && e.t <= end);
    if (inside.length) {
      const first = inside[0], last = inside[inside.length - 1];
      const own = metresEN(first, last);
      const spanM = this.integral(first.t, last.t);
      // The estimate went at least a good part of the way the wheels did: it is the car's own reckoning, not a GPS fix held.
      if (inside.length >= 2 && spanM > 5 && Math.hypot(own.e, own.n) > 0.5 * spanM) {
        const from = this.estAt(a), to = this.estAt(end);
        if (from && to) {
          const d = metresEN(from, to);
          return { dE: d.e, dN: d.n, heading: to.heading, through, by: "est" };
        }
      }
    }
    const headings = [this.headingAt(a), ...inside.map((e) => e.heading)].filter((h): h is number => h != null);
    if (headings.length < 2 || Math.max(...headings.map((h) => angleDiff(h, headings[0]))) < 3) return null;
    let dE = 0, dN = 0;
    for (let t = a; t < end; t += STEP_MS) {
      const dt = Math.min(STEP_MS, end - t);
      const h = this.headingAt(t + dt / 2);
      if (h == null) continue;
      const m = this.integral(t, t + dt);
      dE += m * Math.sin((h * Math.PI) / 180);
      dN += m * Math.cos((h * Math.PI) / 180);
    }
    return { dE, dN, heading: this.headingAt(end), through, by: "heading" };
  }

  /** The heading last said at or before [t] (the first one after, before any). */
  private headingAt(t: number): number | null {
    const i = upperT(this.ests, t) - 1;
    for (let j = i; j >= 0; j--) if (this.ests[j].heading != null) return this.ests[j].heading;
    return this.ests.find((e) => e.heading != null)?.heading ?? null;
  }

  /** The car's estimated place at [t]: the last said before it, carried on along its heading at the speed since. */
  private estAt(t: number): Est | null {
    const i = upperT(this.ests, t) - 1;
    const e = this.ests[i] ?? this.ests[0];
    if (!e) return null;
    if (e.t >= t || e.heading == null) return e;
    const m = this.integral(e.t, t);
    const r = (e.heading * Math.PI) / 180;
    return { ...e, t, lon: e.lon + (m * Math.sin(r)) / (M_PER_DEG * Math.cos((e.lat * Math.PI) / 180)), lat: e.lat + (m * Math.cos(r)) / M_PER_DEG };
  }

  /** The speed held from each sample to the next, summed over [a, b]. */
  private integral(a: number, b: number): number {
    if (b <= a) return 0;
    const s = this.speeds;
    let i = Math.max(0, upper(s, a) - 1);
    let m = 0;
    for (; i < s.length; i++) {
      const from = Math.max(a, s[i].t);
      const to = Math.min(b, i + 1 < s.length ? s[i + 1].t : Infinity);
      if (to > from) m += s[i].v * (to - from) / 1000;
      if (to >= b) break;
    }
    return m;
  }

  /** The odometer at [t]: between readings, straight across; past the last, that reading and the speed since. */
  private odoAt(t: number): number | null {
    const o = this.odos;
    if (!o.length || t < o[0].t) return null;
    const i = upper(o, t) - 1;
    const next = o[i + 1];
    if (!next) return o[i].v + this.integral(o[i].t, t);
    return o[i].v + (next.v - o[i].v) * ((t - o[i].t) / (next.t - o[i].t));
  }
}

function metresEN(a: { lon: number; lat: number }, b: { lon: number; lat: number }): { e: number; n: number } {
  return { e: (b.lon - a.lon) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180), n: (b.lat - a.lat) * M_PER_DEG };
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function upperT(points: { t: number }[], t: number): number {
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the first point after [t]. */
function upper(points: Point[], t: number): number {
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** In time order; the same moment again (a resend) replaces. The index it went to. */
function insert(points: Point[], p: Point): number {
  const last = points[points.length - 1];
  if (!last || p.t > last.t) { points.push(p); return points.length - 1; }
  const i = upper(points, p.t);
  if (i > 0 && points[i - 1].t === p.t) { points[i - 1] = p; return i - 1; }
  points.splice(i, 0, p);
  return i;
}
