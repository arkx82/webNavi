import type { CarTrack } from "./car-track";
import { Line, offset } from "./geo";
import type { Fix, Gps } from "./gps";
import type { Route } from "./types";

/**
 * A pretend car driving the route: fixes along the path at the chosen
 * speed, a few metres of jitter to the side the way a real receiver
 * wobbles — and spaced as the car's browser spaces them ([gaps]): mostly a
 * second apart, but now and then 2–10 s and once in a while 15–30 s with
 * nothing, on an open road (the 진단 log of 2026-10-03's drive: the
 * reckoning ran 1–31 s between fixes all the way). A fix every quarter
 * second, as this gave before, never had the marker reckon outside a
 * tunnel asked for, so what goes wrong then was never met at a desk. Two faults on demand — a tunnel (no fixes for a
 * while) and a wrong turn (60 m off to the side) — so the reckoning and
 * the re-route can be watched at a desk. And the car's own speed and
 * odometer, as the car streams them (car-track.ts), all the while: a
 * jam in the tunnel shows the marker standing with the car.
 */
export class Simulator {
  private line: Line;
  private alongM = 0;
  private timer: number | null = null;
  private lastTick = 0;
  /** m/s */
  speedMps = 50 / 3.6;
  private tunnelUntil = 0;
  private strayUntil = 0;
  /** A jam in the tunnel: from when, and the speed it went in at. */
  private jamFrom = 0;
  private jamFromMps = 0;
  /** The pretend odometer, metres. */
  private odoM = 50_000_000;
  /** Where the pretend car's own speed goes, as the car's streaming would bring it. */
  car: CarTrack | null = null;
  /** Fixes spaced as the car's browser spaces them; false: one a second, never missed. */
  gaps = true;
  private nextFixAt = 0;
  /** Drawn for each wait between fixes: [random] in 0..1 (a test passes its own). */
  random: () => number = Math.random;
  onEnd: () => void = () => {};

  constructor(private gps: Gps, route: Route) {
    this.line = new Line(route.path);
  }

  start(fromM = 0) {
    this.gps.stop();
    this.alongM = fromM;
    this.lastTick = performance.now();
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 250);
  }

  stop() {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  get running() {
    return this.timer != null;
  }

  /** No fixes for [seconds]; the marker must carry on by itself. */
  tunnel(seconds = 10) {
    this.tunnelUntil = performance.now() + seconds * 1000;
  }

  /**
   * A tunnel with a jam in it, for [seconds]: down to standing in five
   * seconds, standing for half the time, creeping at 10 km/h, and the
   * last stretch at the speed it went in at.
   */
  tunnelJam(seconds = 60) {
    this.tunnel(seconds);
    this.jamFrom = performance.now();
    this.jamFromMps = this.speedMps;
  }

  /** The speed the pretend car goes at now: the chosen one, unless it is in the jam. */
  private speedNow(now: number): number {
    if (!this.jamFrom || now >= this.tunnelUntil) { this.jamFrom = 0; return this.speedMps; }
    const s = (now - this.jamFrom) / 1000, total = (this.tunnelUntil - this.jamFrom) / 1000;
    if (s < 5) return this.jamFromMps * (1 - s / 5);
    if (s < total * 0.5) return 0;
    if (s < total * 0.8) return 10 / 3.6;
    return this.jamFromMps;
  }

  /** Seconds to the next fix: 1, or one of the car browser's silences. */
  private waitS(): number {
    if (!this.gaps) return 1;
    const r = this.random();
    if (r < 0.75) return 1;
    if (r < 0.95) return 2 + ((r - 0.75) / 0.2) * 8;
    return 15 + ((r - 0.95) / 0.05) * 15;
  }

  /** Off the route to the right for [seconds]; the app should re-route. */
  stray(seconds = 8) {
    this.strayUntil = performance.now() + seconds * 1000;
  }

  /** The route changed under the car (a re-route); keep driving the new one from its start. */
  /** A new route: from its start — or, [keepPlace], the same route with its line moved (onto the lanes): from where the car is on it. */
  follow(route: Route, keepPlace = false) {
    const was = keepPlace && this.line ? this.line.place(this.alongM).at : null;
    this.line = new Line(route.path);
    this.alongM = was ? this.line.project(was, 0, this.line.path.length).alongM : 0;
  }

  private tick() {
    const now = performance.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    const speed = this.speedNow(now);
    this.alongM += speed * dt;
    this.odoM += speed * dt;
    // The car's streaming, through the tunnel too (the LTE holds where the GPS does not); its odometer to the metre.
    this.car?.add({ t: Date.now(), speedMps: speed, odoM: this.odoM, odoResM: 1.6 });
    if (this.alongM >= this.line.lengthM) {
      this.alongM = this.line.lengthM;
      this.stop();
      this.onEnd();
    }
    if (now < this.tunnelUntil) return; // in the dark: nothing arrives
    if (now < this.nextFixAt) return;
    this.nextFixAt = now + this.waitS() * 1000;
    const p = this.line.place(this.alongM);
    const wobble = (Math.random() - 0.5) * 6;
    const side = now < this.strayUntil ? 60 : wobble;
    const at = offset(p.at, p.bearing + 90, side);
    const fix: Fix = {
      t: Date.now(),
      lon: at[0],
      lat: at[1],
      accM: 5 + Math.random() * 4,
      speed,
      heading: p.bearing,
      course: null,
    };
    this.gps.feed(fix);
  }
}
