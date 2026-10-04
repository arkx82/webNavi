import type { CarTrack } from "./car-track";
import type { Fix } from "./gps";
import { Line, angleBetween, bearing, lerpAngle, metres, offset, type Projection } from "./geo";
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
/** How far ahead of its last fix the car is carried by its speed before it waits for the next. */
const PREDICT_S = 2.5;
/** How quickly the drawn car closes on where the fixes say it is: most of the way in a couple of seconds. */
const CATCH_UP_S = 1.2;
/** The closing never adds or takes more than this share of the car's speed: a fix's wander must not be felt as a surge. */
const CATCH_UP_SHARE = 0.3;
/** A fix this far from the drawn car (a leap) is taken at once, not slid to. */
const LEAP_M = 40;
/**
 * Reckoning only at a real speed, and only when the fixes have stopped (a
 * tunnel), not when they come vague (a garage, where they wander tens of
 * metres and a speed made from that sent the marker flying). In a tunnel
 * it goes on for as long as a long one takes, at the traffic's own pace on
 * that stretch: a jam in 인제양양터널 is not driven through at 80.
 */
export const RECKON_MIN_MPS = 3;
export const RECKON_MAX_S = 600;
/** With the car's own speed (car-track.ts) the reckoning is measured, not guessed: it goes on for as long as a jam lasts. */
export const RECKON_CAR_MAX_S = 1800;
/** m/s at most on a stretch the route says is slow (2) or jammed (3). */
const CONGESTED_MPS: Partial<Record<number, number>> = { 2: 8, 3: 3 };
/** A fix vaguer than this does not move the marker, unless the browser says the car is moving. */
export const VAGUE_ACC_M = 40;
/** Below this the heading is held where it was. */
export const HEADING_MIN_MPS = 1.4;
/** How far ahead the camera looks, in seconds of travel, and its bounds in metres. */
export const LOOKAHEAD_S = 2.5;
export const LOOKAHEAD_MIN_M = 40;
export const LOOKAHEAD_MAX_M = 150;

export type Mode = "waiting" | "gps" | "reckoning" | "snapping";

/** How a reckoning ended: how long, on what, and how far the fix that ended it was from where it had the car. */
export interface ReckonEnd {
  seconds: number;
  by: "car" | "speed";
  /** Metres along the route, the fix ahead (+) or behind (−) of the reckoned place; off the road, how far apart (≥ 0). */
  errorM: number | null;
  /** Reckoned off the road (no route, or off it), on the car's own heading or estimate. */
  free: boolean;
}

export interface Shown {
  at: LonLat;
  bearing: number;
  speedMps: number;
  mode: Mode;
  /** While reckoning: on the car's own speed, or the last fix's held. */
  reckonBy?: "car" | "speed";
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
  /** On the road, the glide's ends as metres along it, so a bend is followed round, not cut across. */
  private glideFromAlong: number | null = null;
  private glideToAlong: number | null = null;
  private shownAlong: number | null = null;
  /** When the last frame was drawn: the car on the road moves by the time since, at its speed. */
  private lastFrameAt = 0;

  private speedMps = 0;
  private reckonAlong = 0;
  private reckonSince = 0;
  private reckonBy: "car" | "speed" = "speed";
  /** The last fix believed, by its own clock (Date.now) and ours (performance.now): where the car's distance is counted from. */
  private fixWall = 0;
  private fixPerf = 0;
  /** The car's own speed and odometer (car-track.ts), when the car streams them; without, the last fix's speed is held. */
  car: Pick<CarTrack, "between" | "lastSpeed" | "freePath" | "lastAt" | "parked"> | null = null;
  /** Guides passed over, neither the next turn shown nor the one after it (main.ts: those that name no choice). */
  quiet: (g: Guide, route: Route) => boolean = () => false;
  /** The reckoning now is off the road (car-track.ts freePath). */
  private reckonFree = false;
  /** Parked as of the last frame: the place it was drawn at then is where it stays. */
  private wasParked = false;
  private offSince: number | null = null;
  /** Since when the car has been well clear of the road, on good fixes. */
  private farSince: number | null = null;
  private declaredOff = false;
  private declaredAt = 0;

  onOffRoute: (at: LonLat) => void = () => {};
  /** A reckoning over, the fixes back: for the log, to see how far off it was. */
  onReckonEnd: (r: ReckonEnd) => void = () => {};

  setRoute(route: Route | null) {
    this.route = route;
    this.glideFromAlong = this.glideToAlong = this.shownAlong = null;
    this.line = route && route.path.length > 1 ? new Line(route.path) : null;
    this.guides = [];
    this.lastProj = null;
    this.offSince = null;
    this.farSince = null;
    this.declaredOff = false;
    if (this.line) {
      for (const g of route!.guides) {
        if (this.quiet(g, route!)) continue;
        this.guides.push({ guide: g, alongM: this.line.project(g.at, 0, this.line.path.length).alongM });
      }
      this.guides.sort((a, b) => a.alongM - b.alongM);
      // The reckoning goes on from the last fix's place on this line, not the metres along the old one: a route
      // changed between two of the car browser's sparse fixes had the marker leap 1583 m on (2026-10-03).
      if (this.lastFix) {
        this.lastProj = this.line.project([this.lastFix.lon, this.lastFix.lat], 0, this.line.path.length);
        this.reckonAlong = this.lastProj.alongM;
      }
    }
  }

  /** Forgets where the car was drawn (a pretend drive over): the next fix places it afresh, no glide from the pretend place. */
  forget() {
    this.glideFromAlong = this.glideToAlong = this.shownAlong = null;
    this.lastFix = null;
    this.lastProj = null;
    this.shownAt = null;
    this.glideFrom = null;
    this.glideTo = null;
    this.reckonSince = 0;
  }

  /** A fix from the car (or a replay). */
  feed(fix: Fix, now = performance.now()) {
    if (this.lastFix) this.periodS = Math.min(3, Math.max(0.2, (fix.t - this.lastFix.t) / 1000));
    // Vague and not said to be moving (a garage, an underpass): the car is where it was.
    const saysMoving = fix.speed != null && fix.speed >= RECKON_MIN_MPS;
    // The car itself says it is moving (its own speed, of late): the vague fix is not believed to hold it — no fix
    // at all, as far as the drawing goes, so the reckoning on the car's word takes over.
    const carLast = this.car?.lastAt;
    // Parked, by the car's own gear: it is where it was, facing the way it was. A fix only refines the place when it
    // is clearly sharper than the one that put it there; the wander of the rest (10–20 m in a car park) moves nothing.
    const parked = !saysMoving && !!this.car?.parked(fix.t);
    if (this.lastFix && parked && !(fix.accM < this.lastFix.accM * 0.7)) {
      this.lastFixAt = now;
      this.speedMps = 0;
      this.reckonSince = 0;
      this.reckonFree = false;
      return;
    }
    if (this.lastFix && fix.accM > VAGUE_ACC_M && !saysMoving && carLast != null && fix.t - carLast < 10_000 && (this.car!.lastSpeed() ?? 0) > 1.5) return;
    if (this.lastFix && fix.accM > VAGUE_ACC_M && !saysMoving) {
      this.lastFixAt = now;
      this.speedMps = 0;
      return;
    }
    const previous = this.lastFix;
    this.lastFix = fix;
    this.lastFixAt = now;
    this.fixWall = fix.t;
    this.fixPerf = now;
    if (fix.speed != null && fix.speed >= 0) this.speedMps = fix.speed;
    else if (previous && fix.accM <= 25 && previous.accM <= 25) {
      // Worked out from two good fixes, smoothed, and never beyond what the wander of the two could make.
      const moved = metres(previous.lon, previous.lat, fix.lon, fix.lat);
      const raw = Math.max(0, moved - Math.max(fix.accM, previous.accM) * 0.5) / this.periodS;
      this.speedMps = this.speedMps * 0.6 + Math.min(raw, 70) * 0.4;
    } else this.speedMps = 0;
    if (parked) this.speedMps = 0;

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
        // The glide from where the car is drawn along the road to this fix's place on it (a first fix, or one
        // after being off the road, starts here).
        this.glideFromAlong = this.shownAlong ?? proj.alongM;
        this.glideToAlong = proj.alongM;
        bearing = this.speedMps > 2 ? proj.bearing : bearing;
        this.offSince = null;
        this.farSince = null;
        this.declaredOff = false;
      } else {
        this.glideFromAlong = this.glideToAlong = this.shownAlong = null;
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
    // Only a good fix ends it for the record: a vague one in the dark goes on reckoning from its own place.
    if (wasReckoning && fix.accM <= LOST_ACC_M) {
      const errorM = this.reckonFree
        ? (this.shownAt ? metres(this.shownAt[0], this.shownAt[1], target[0], target[1]) : null)
        : this.glideToAlong != null && this.glideFromAlong != null ? this.glideToAlong - this.glideFromAlong : null;
      this.onReckonEnd({ seconds: (now - this.reckonSince) / 1000, by: this.reckonBy, errorM, free: this.reckonFree });
    }
    this.reckonSince = 0;
    this.reckonFree = false;
    this.startGlide(target, now, wasReckoning ? SNAP_S : this.periodS);
    this.shownBearing = bearing;
  }

  /** The last speed, held to the traffic's pace where the route says its stretch is slow or jammed. */
  private reckonSpeed(speed = this.speedMps): number {
    if (!this.route || !this.line) return speed;
    const i = this.lastProj?.segment ?? 0;
    const seg = this.route.segments.find((s) => i >= s.from && i < s.to);
    const cap = seg ? CONGESTED_MPS[seg.congestion] : undefined;
    return cap != null ? Math.min(speed, cap) : speed;
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
    // The car's own word on the way it went since the last fix, while it streams: then a car that went in slowly,
    // or stands in a jam inside, is placed by what it did.
    const wallNow = this.fixWall + (now - this.fixPerf);
    // Parked: nothing to reckon, the fixes' silence or not, and the last fix's speed is not carried on.
    const parked = !!this.car?.parked(wallNow);
    if (parked) this.speedMps = 0;
    // Put in P where it was drawn — reckoned into a car park, say — it stays there: not taken back to the last fix
    // (its entrance). A sharper fix still moves it (feed), from here.
    if (parked && !this.wasParked && this.shownAt) {
      this.glideFrom = this.glideTo = this.shownAt;
      if (this.shownAlong != null) { this.glideFromAlong = this.glideToAlong = this.shownAlong; this.reckonAlong = this.shownAlong; }
      this.reckonSince = 0;
      this.reckonFree = false;
    }
    this.wasParked = parked;
    const byCar = lost && !parked && this.line && this.car ? this.car.between(this.fixWall, wallNow) : null;
    // Only a car really moving (or that says how it moves), on a route, and for a tunnel's length: past that it waits for a fix.
    const reckon = lost && !parked && lostForS <= (byCar ? RECKON_CAR_MAX_S : RECKON_MAX_S) && (byCar != null || this.speedMps >= RECKON_MIN_MPS);
    // Off the road (no route, or declared off it) — a terminal, a car park — only on the car's word, and only where
    // its heading or its own idea of its place is seen to live on without the fixes (car-track.ts freePath).
    const free = lost && !parked && this.car && (!this.line || this.declaredOff) && lostForS <= RECKON_CAR_MAX_S ? this.car.freePath(this.fixWall, wallNow) : null;
    /** Where reckoning put the car this frame: its own along, not a projection back onto the line each frame. */
    let reckoned: Projection | null = null;

    if (reckon && this.line && !this.declaredOff) {
      // Reckoning: advance along the route from the place the last fix put us, by the car's own distance — and
      // past where it stops (the link gone too), at the speed it last said — or, without it, at the last fix's speed.
      mode = "reckoning";
      if (this.reckonSince === 0) this.reckonSince = now;
      this.reckonBy = byCar ? "car" : "speed";
      this.reckonFree = false;
      const ahead = byCar
        ? this.reckonAlong + byCar.m + this.reckonSpeed(this.car!.lastSpeed() ?? this.speedMps) * (Math.max(0, wallNow - byCar.through) / 1000)
        : this.reckonAlong + this.reckonSpeed() * ((now - this.lastFixAt) / 1000);
      reckoned = this.line.place(ahead);
      this.shownAt = reckoned.at;
      this.shownAlong = reckoned.alongM;
      this.shownBearing = reckoned.bearing;
    } else if (free) {
      // From the last fix's place, the way the car's figures say it went; past where they stop, on at its last
      // speed along its last heading.
      mode = "reckoning";
      if (this.reckonSince === 0) this.reckonSince = now;
      this.reckonBy = "car";
      this.reckonFree = true;
      const way = Math.hypot(free.dE, free.dN);
      let at = way > 0 ? offset(this.glideTo, (Math.atan2(free.dE, free.dN) * 180) / Math.PI, way) : this.glideTo;
      const heading = free.heading ?? this.shownBearing;
      const beyond = (this.car!.lastSpeed() ?? 0) * (Math.max(0, wallNow - free.through) / 1000);
      if (beyond > 0) at = offset(at, heading, beyond);
      this.shownAt = at;
      this.shownAlong = null;
      if (free.heading != null) this.shownBearing = free.heading;
    } else {
      const t = Math.min(1, (now - this.glideStart) / (this.glideS * 1000));
      if (this.line && this.glideToAlong != null) {
        // On the road the car is kept moving at its speed, frame by frame, and steered toward where the last fix
        // says it should be by now — the fix's place plus the way travelled since. A glide that ran from fix to fix
        // stopped dead at each one and jumped when the next came late; this never stops while the car moves.
        // The time since the last frame, whole up to a second: held to a quarter, a page drawing four frames a second or
        // fewer (a busy car computer) moved the car less than it went, and the lag grew to 40 m at 110 km/h (2026-10-05).
        const dt = this.lastFrameAt ? Math.min(1, (now - this.lastFrameAt) / 1000) : 0;
        const predicted = this.glideToAlong + this.speedMps * Math.min(PREDICT_S, (now - this.lastFixAt) / 1000);
        let along = this.shownAlong ?? predicted;
        // Past PREDICT_S the place it is steered to stands: the car is carried no further than that, not crept on
        // for as long as the fixes stay away (a car park, a car too slow to reckon on).
        along = (now - this.lastFixAt) / 1000 > PREDICT_S ? Math.max(along, Math.min(predicted, along + this.speedMps * dt)) : along + this.speedMps * dt;
        if (this.glideS === SNAP_S && t < 1 && this.glideFromAlong != null) {
          // Out of a tunnel: from where the reckoning had the car to where the fix says, eased over SNAP_S — however
          // far the two were apart, a slide, not the leap a jump in the fixes is taken with.
          along = this.glideFromAlong + (predicted - this.glideFromAlong) * (t * t * (3 - 2 * t));
        } else {
          // The error closed with a time constant: a small one melts away, a large one (a leap in the fixes) is taken.
          const gap = predicted - along;
          const close = gap * (1 - Math.exp(-dt / CATCH_UP_S));
          const most = Math.max(0.5, this.speedMps * CATCH_UP_SHARE) * dt;
          along += Math.abs(gap) > LEAP_M ? gap : Math.max(-most, Math.min(most, close));
        }
        along = Math.max(0, Math.min(this.line.lengthM, along));
        const placed = this.line.place(along);
        this.shownAt = placed.at;
        this.shownAlong = along;
        if (this.speedMps > 2) this.shownBearing = placed.bearing;
      } else {
        this.shownAt = [
          this.glideFrom[0] + (this.glideTo[0] - this.glideFrom[0]) * t,
          this.glideFrom[1] + (this.glideTo[1] - this.glideFrom[1]) * t,
        ];
      }
      if (this.glideS === SNAP_S && t < 1) mode = "snapping";
    }
    this.lastFrameAt = now;

    const shown: Shown = {
      at: this.shownAt,
      bearing: this.shownBearing,
      // Reckoning on the car's word, its speed is the car's too (the zoom, the speed shown).
      speedMps: mode === "reckoning" && this.reckonBy === "car" ? this.car!.lastSpeed() ?? this.speedMps : this.speedMps,
      mode,
      ...(mode === "reckoning" ? { reckonBy: this.reckonBy } : {}),
      offRoute: this.declaredOff,
    };
    if (this.line && this.route) {
      const along = reckoned ? reckoned.alongM : (this.lastProj?.alongM ?? 0);
      shown.alongM = along;
      shown.offM = this.lastProj?.offM;
      shown.remainingM = Math.max(0, this.line.lengthM - along);
      // Never less than nothing, whatever a provider's fresh time made of durationS (main.ts freshTraffic).
      shown.remainingS = Math.max(0, this.route.durationS * (shown.remainingM / Math.max(1, this.line.lengthM)));
      const i = this.guides.findIndex((g) => g.alongM > along + 5);
      if (i >= 0) {
        shown.nextGuide = { guide: this.guides[i].guide, inM: this.guides[i].alongM - along };
        const then = this.guides[i + 1];
        if (then) shown.thenGuide = { guide: then.guide, inM: then.alongM - along };
      }
    }
    return shown;
  }

  /**
   * The bearing the camera turns toward: the way to the road LOOKAHEAD_S
   * ahead (40–150 m), as the chord from the car, not the bearing of the one
   * segment there. A segment's bearing steps at every vertex of the line,
   * and a camera tracking it turned at every one; the chord changes
   * smoothly through a bend and sees the bend as a whole, the way the
   * car apps' cameras do. Turned by [share] of the way, and never more
   * than [maxDeg] (a re-route, a U-turn: swung, not snapped).
   */
  cameraBearing(current: number, share = 0.15, maxDeg = Infinity): number {
    let target = this.shownBearing;
    if (this.line && this.shownAlong != null && this.shownAt && this.speedMps > 1.5) {
      const lookaheadM = Math.min(LOOKAHEAD_MAX_M, Math.max(LOOKAHEAD_MIN_M, this.speedMps * LOOKAHEAD_S));
      const targetAlong = Math.min(this.line.lengthM, this.shownAlong + lookaheadM);
      if (targetAlong > this.shownAlong + 5) {
        const ahead = this.line.place(targetAlong).at;
        const chord = bearing(this.shownAt[0], this.shownAt[1], ahead[0], ahead[1]);
        if (Number.isFinite(chord)) target = chord;
      }
    }
    const eased = lerpAngle(current, target, share);
    let step = eased - current;
    while (step > 180) step -= 360;
    while (step < -180) step += 360;
    return (current + Math.max(-maxDeg, Math.min(maxDeg, step)) + 360) % 360;
  }
}
