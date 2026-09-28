/**
 * The car's fix, one a second if the browser gives it: what came, when,
 * and how good. Week one is finding out what the Tesla browser actually
 * hands over — speed and heading are optional in the spec and null on many
 * browsers — so every sample is kept and can be saved for the record.
 */
export interface Fix {
  t: number;
  lon: number;
  lat: number;
  accM: number;
  /** m/s, null when the browser does not say. */
  speed: number | null;
  /** Degrees clockwise from north, null when unknown or standing still. */
  heading: number | null;
  /**
   * The heading to steer the map by: the browser's when it gives one and
   * the car is moving, else the bearing from the previous fix, smoothed.
   * teslanav.com found the browser's heading unreliable; this keeps both.
   */
  course: number | null;
}

const MIN_MOVE_M = 3;
const MIN_SPEED_MPS = 1.4;

export function bearing(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function metres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const x = (lon2 - lon1) * 111_320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const y = (lat2 - lat1) * 111_320;
  return Math.hypot(x, y);
}

/** Turns [from] toward [to] by [t] of the short way round. */
export function lerpAngle(from: number, to: number, t: number): number {
  let d = to - from;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return (from + d * t + 360) % 360;
}

export type FixListener = (fix: Fix, samples: Fix[]) => void;

export class Gps {
  readonly samples: Fix[] = [];
  private watch: number | null = null;
  private listeners: FixListener[] = [];
  onError: (message: string) => void = () => {};

  start() {
    if (!("geolocation" in navigator)) {
      this.onError("이 브라우저에는 Geolocation이 없음");
      return;
    }
    this.watch = navigator.geolocation.watchPosition(
      (p) => {
        const fix: Fix = {
          t: p.timestamp,
          lon: p.coords.longitude,
          lat: p.coords.latitude,
          accM: p.coords.accuracy,
          speed: p.coords.speed,
          heading: p.coords.heading,
          course: null,
        };
        fix.course = this.courseOf(fix);
        this.samples.push(fix);
        if (this.samples.length > 36_000) this.samples.shift(); // ten hours at 1 Hz
        for (const l of this.listeners) l(fix, this.samples);
      },
      (e) => this.onError(`${e.code}: ${e.message}`),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 },
    );
  }

  private courseOf(fix: Fix): number | null {
    const last = this.samples[this.samples.length - 1];
    const lastCourse = last?.course ?? null;
    if (fix.heading != null && !Number.isNaN(fix.heading) && (fix.speed ?? 0) > MIN_SPEED_MPS) {
      return fix.heading;
    }
    if (!last) return null;
    const moved = metres(last.lon, last.lat, fix.lon, fix.lat);
    const dt = (fix.t - last.t) / 1000;
    if (moved < MIN_MOVE_M || dt <= 0 || dt > 30) return lastCourse;
    const raw = bearing(last.lon, last.lat, fix.lon, fix.lat);
    return lastCourse == null ? raw : lerpAngle(lastCourse, raw, 0.3);
  }

  stop() {
    if (this.watch != null) navigator.geolocation.clearWatch(this.watch);
    this.watch = null;
  }

  on(listener: FixListener) {
    this.listeners.push(listener);
  }

  /** Seconds between the last two fixes: the real update period. */
  period(): number | null {
    const n = this.samples.length;
    if (n < 2) return null;
    return (this.samples[n - 1].t - this.samples[n - 2].t) / 1000;
  }

  asCsv(): string {
    const head = "t,iso,lon,lat,accM,speed,heading,course\n";
    return head + this.samples
      .map((s) => `${s.t},${new Date(s.t).toISOString()},${s.lon},${s.lat},${s.accM},${s.speed ?? ""},${s.heading ?? ""},${s.course ?? ""}`)
      .join("\n");
  }
}
