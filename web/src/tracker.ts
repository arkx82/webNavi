import type { Fix } from "./gps";
import { Line, angleBetween, lerpAngle, metres, offset, type Projection } from "./geo";
import type { Guide, LonLat, Route } from "./types";

/**
 * Where the car is shown, sixty times a second, from fixes that come once
 * a second and sometimes not at all.
 *
 * With a route: each fix is snapped onto it (the car is on the road, not
 * 8 m to the side of it), the marker glides from the last shown place to
 * the snapped one over a fix period, and when fixes stop — a tunnel — the
 * marker keeps going along the route at the last speed. When they return,
 * the marker slides to the truth over 1.5 s rather than jumping.
 *
 * Without a route: the same glide between raw fixes, no reckoning.
 *
 * Off-route is called only after the car has been more than OFF_M from the
 * road for OFF_S seconds, since a single fix can be 30 m out on its own —
 * or, well clear of it (OFF_FAR_M, with a fix good enough to believe), after
 * OFF_FAR_S. While the car stays off, it is called again every OFF_AGAIN_S:
 * a re-route that failed, or came back while the car was still turning
 * away, is asked again rather than left.
 */
export const OFF_M = 35;
export const OFF_S = 3;
export const OFF_FAR_M = 60;
export const OFF_FAR_S = 1;
/** A fix believed for OFF_FAR_M: GPS between towers can put one 60 m out. */
export const OFF_FAR_ACC_M = 25;
export const OFF_AGAIN_S = 6;
export const LOST_S = 2;
export const LOST_ACC_M = 50;
export const SNAP_S = 1.5;
/**
 * Reckoning only at a real speed, and only when the fixes have stopped (a
 * tunnel), not when they come vague (a garage, where they wander tens of
 * metres and a speed made from that sent the marker flying). In a tunnel
 * it goes on for as long as a long one takes, at the traffic's own pace on
 * that stretch: a jam in 인제양양터널 is not driven through at 80.
 */
export const RECKON_MIN_MPS = 3;
export const RECKON_MAX_S = 600;
/** m/s at most on a stretch the route says is slow (2) or jammed (3). */
const CONGESTED_MPS: Partial<Record<number, number>> = { 2: 8, 3: 3 };
/** A fix vaguer than this does not move the marker, unless the browser says the car is moving. */
export const VAGUE_ACC_M = 40;
/** Below this the heading is held where it was. */
export const HEADING_MIN_MPS = 1.4;

export type Mode = "waiting" | "gps" | "reckoning" | "snapping";

export interface Shown {
  at: LonLat;
  bearing: number;
  speedMps: number;
  mode: Mode;
  /** Only while a route is set. */
  alongM?: number;
  offM?: number;
  remainingM?: number;
  remainingS?: number;
  nextGuide?: { guide: Guide; inM: number };
  /** The one after it, for the "then" line. */
  thenGuide?: { guide: Guide; inM: number };
  offRoute: boolean;
}

interface GuideAlong {
  guide: Guide;
  alongM: number;
}

export class Tracker {
  private line: Line | null = null;
  private route: Route | null = null;
  private guides: GuideAlong[] = [];

  private lastFix: Fix | null = null;
  private lastProj: Projection | null = null;
  private lastFixAt = 0;
  private periodS = 1;

  // What is drawn, and where it is heading.
  private shownAt: LonLat | null = null;
  private shownBearing = 0;
  private glideFrom: LonLat | null = null;
  private glideTo: LonLat | null = null;
  private glideStart = 0;
  private glideS = 1;

  private speedMps = 0;
  private reckonAlong = 0;
  private reckonSince = 0;
  private offSince: number | null = null;
  /** Since when the car has been well clear of the road, on good fixes. */
  private farSince: number | null = null;
  private declaredOff = false;
  private declaredAt = 0;

  onOffRoute: (at: LonLat) => void = () => {};

  setRoute(route: Route | null) {
    this.route = route;
    this.line = route && route.path.length > 1 ? new Line(route.path) : null;
    this.guides = [];
    this.lastProj = null;
    this.offSince = null;
    this.farSince = null;
    this.declaredOff = false;
    if (this.line) {
      for (const g of route!.guides) {
        this.guides.push({ guide: g, alongM: this.line.project(g.at, 0, this.line.path.length).alongM });
      }
      this.guides.sort((a, b) => a.alongM - b.alongM);
    }
  }

  /** A fix from the car (or a replay). */
  feed(fix: Fix, now = performance.now()) {
    if (this.lastFix) this.periodS = Math.min(3, Math.max(0.2, (fix.t - this.lastFix.t) / 1000));
    // Vague and not said to be moving (a garage, an underpass): the car is where it was.
    const saysMoving = fix.speed != null && fix.speed >= RECKON_MIN_MPS;
    if (this.lastFix && fix.accM > VAGUE_ACC_M && !saysMoving) {
      this.lastFixAt = now;
      this.speedMps = 0;
      return;
    }
    const previous = this.lastFix;
    this.lastFix = fix;
    this.lastFixAt = now;
    if (fix.speed != null && fix.speed >= 0) this.speedMps = fix.speed;
    else if (previous && fix.accM <= 25 && previous.accM <= 25) {
      // Worked out from two good fixes, smoothed, and never beyond what the wander of the two could make.
      const moved = metres(previous.lon, previous.lat, fix.lon, fix.lat);
      const raw = Math.max(0, moved - Math.max(fix.accM, previous.accM) * 0.5) / this.periodS;
      this.speedMps = this.speedMps * 0.6 + Math.min(raw, 70) * 0.4;
    } else this.speedMps = 0;

    let target: LonLat = [fix.lon, fix.lat];
    // Standing or creeping (under 5 km/h), the way the car points is kept: GPS wander would spin the map.
    let bearing = this.speedMps < HEADING_MIN_MPS ? this.shownBearing : (fix.course ?? this.shownBearing);

    if (this.line) {
      const proj = this.line.project(target, this.lastProj?.segment ?? 0);
      this.lastProj = proj;
      // Snapped only when close and pointing the road's way; a car on a
      // parallel street is not on this road.
      const aligned = fix.course == null || angleBetween(fix.course, proj.bearing) < 60 || (fix.speed ?? 0) < 2;
      if (proj.offM <= OFF_M && aligned) {
        target = proj.at;
        bearing = this.speedMps > 2 ? proj.bearing : bearing;
        this.offSince = null;
        this.farSince = null;
        this.declaredOff = false;
      } else {
        this.offSince ??= now;
        const far = proj.offM > OFF_FAR_M && fix.accM <= OFF_FAR_ACC_M;
        this.farSince = far ? (this.farSince ?? now) : null;
        const off = now - this.offSince >= OFF_S * 1000 || (this.farSince != null && now - this.farSince >= OFF_FAR_S * 1000);
        if (off && (!this.declaredOff || now - this.declaredAt >= OFF_AGAIN_S * 1000)) {
          this.declaredOff = true;
          this.declaredAt = now;
          this.onOffRoute([fix.lon, fix.lat]);
        }
      }
      this.reckonAlong = proj.alongM;
    }

    // Coming out of a tunnel: from wherever reckoning left the marker.
    const wasReckoning = this.reckonSince > 0;
    this.reckonSince = 0;
    this.startGlide(target, now, wasReckoning ? SNAP_S : this.periodS);
    this.shownBearing = bearing;
  }

  /** The last speed, held to the traffic's pace where the route says its stretch is slow or jammed. */
  private reckonSpeed(): number {
    if (!this.route || !this.line) return this.speedMps;
    const i = this.lastProj?.segment ?? 0;
    const seg = this.route.segments.find((s) => i >= s.from && i < s.to);
    const cap = seg ? CONGESTED_MPS[seg.congestion] : undefined;
    return cap != null ? Math.min(this.speedMps, cap) : this.speedMps;
  }

  private startGlide(to: LonLat, now: number, seconds: number) {
    this.glideFrom = this.shownAt ?? to;
    this.glideTo = to;
    this.glideStart = now;
    this.glideS = seconds;
  }

  /** What to draw right now. Call from requestAnimationFrame. */
  frame(now = performance.now()): Shown | null {
    if (!this.lastFix || !this.glideTo || !this.glideFrom) return null;
    let mode: Mode = "gps";
    const lostForS = (now - this.lastFixAt) / 1000;
    const lost = lostForS > LOST_S || this.lastFix.accM > LOST_ACC_M;
    // Only a car really moving, on a route, and for a tunnel's length: past that it waits for a fix.
    const reckon = lost && this.speedMps >= RECKON_MIN_MPS && lostForS <= RECKON_MAX_S;
    /** Where reckoning put the car this frame: its own along, not a projection back onto the line each frame. */
    let reckoned: Projection | null = null;

    if (reckon && this.line && !this.declaredOff) {
      // Reckoning: advance along the route at the last speed, from the
      // place the last fix put us.
      mode = "reckoning";
      if (this.reckonSince === 0) this.reckonSince = now;
      const ahead = this.reckonAlong + this.reckonSpeed() * ((now - this.lastFixAt) / 1000);
      reckoned = this.line.place(ahead);
      this.shownAt = reckoned.at;
      this.shownBearing = reckoned.bearing;
    } else {
      const t = Math.min(1, (now - this.glideStart) / (this.glideS * 1000));
      this.shownAt = [
        this.glideFrom[0] + (this.glideTo[0] - this.glideFrom[0]) * t,
        this.glideFrom[1] + (this.glideTo[1] - this.glideFrom[1]) * t,
      ];
      if (this.glideS === SNAP_S && t < 1) mode = "snapping";
    }

    const shown: Shown = {
      at: this.shownAt,
      bearing: this.shownBearing,
      speedMps: this.speedMps,
      mode,
      offRoute: this.declaredOff,
    };
    if (this.line && this.route) {
      const along = reckoned ? reckoned.alongM : (this.lastProj?.alongM ?? 0);
      shown.alongM = along;
      shown.offM = this.lastProj?.offM;
      shown.remainingM = Math.max(0, this.line.lengthM - along);
      shown.remainingS = this.route.durationS * (shown.remainingM / Math.max(1, this.line.lengthM));
      const i = this.guides.findIndex((g) => g.alongM > along + 5);
      if (i >= 0) {
        shown.nextGuide = { guide: this.guides[i].guide, inM: this.guides[i].alongM - along };
        const then = this.guides[i + 1];
        if (then) shown.thenGuide = { guide: then.guide, inM: then.alongM - along };
      }
    }
    return shown;
  }

  /** Smoothed bearing for the camera: turns toward the shown bearing. */
  cameraBearing(current: number): number {
    return lerpAngle(current, this.shownBearing, 0.15);
  }
}
