/**
 * How soon the road may be asked again after the car is called off it.
 * A provider whose route begins further from the car than the tracker's
 * OFF_M (a one-way street, a car park, a fix 40 m out) has the car called
 * off again within a few seconds, and asked again, and again — a request a
 * second and "경로를 벗어났습니다" over and over. So each re-route in a row
 * waits longer than the last, and only a spell of driving on the route
 * (ON_ROUTE_RESET_MS) makes the next one quick again.
 */
export const REROUTE_WAITS_S = [0, 5, 15, 45];
export const ON_ROUTE_RESET_MS = 30_000;

export class RerouteBackoff {
  private tries = 0;
  private lastAt = -Infinity;
  private onSince: number | null = null;

  /** Seconds still to wait before the next re-route; 0 when one may go now (which counts it). */
  ask(now = Date.now()): number {
    const wait = REROUTE_WAITS_S[Math.min(this.tries, REROUTE_WAITS_S.length - 1)] * 1000;
    const left = this.lastAt + wait - now;
    if (left > 0) return left / 1000;
    this.tries++;
    this.lastAt = now;
    this.onSince = null;
    return 0;
  }

  /** Each frame: whether the car is on the route now. Half a minute of it, and the count starts over. */
  seen(onRoute: boolean, now = Date.now()) {
    if (!onRoute) { this.onSince = null; return; }
    this.onSince ??= now;
    if (now - this.onSince >= ON_ROUTE_RESET_MS) this.tries = 0;
  }

  /** A new drive: nothing owed from the last. */
  reset() {
    this.tries = 0;
    this.lastAt = -Infinity;
    this.onSince = null;
  }
}
