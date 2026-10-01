import { Line, offset } from "./geo";
import type { Fix, Gps } from "./gps";
import type { Route } from "./types";

/**
 * A pretend car driving the route: a fix a second, along the path at
 * the chosen speed, a few metres of jitter to the side the way a real
 * receiver wobbles. Two faults on demand — a tunnel (no fixes for a
 * while) and a wrong turn (60 m off to the side) — so the reckoning and
 * the re-route can be watched at a desk.
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
    this.alongM += this.speedMps * dt;
    if (this.alongM >= this.line.lengthM) {
      this.alongM = this.line.lengthM;
      this.stop();
      this.onEnd();
    }
    if (now < this.tunnelUntil) return; // in the dark: nothing arrives
    const p = this.line.place(this.alongM);
    const wobble = (Math.random() - 0.5) * 6;
    const side = now < this.strayUntil ? 60 : wobble;
    const at = offset(p.at, p.bearing + 90, side);
    const fix: Fix = {
      t: Date.now(),
      lon: at[0],
      lat: at[1],
      accM: 5 + Math.random() * 4,
      speed: this.speedMps,
      heading: p.bearing,
      course: null,
    };
    this.gps.feed(fix);
  }
}
