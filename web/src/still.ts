import { metres } from "./geo";
import type { LonLat } from "./types";

/** Standing this long, and the road round the car is not asked about again until it moves. */
export const STILL_AFTER_MS = 5 * 60_000;
/** Fixes wander this much standing still (a garage more, but there the speed says nothing either). */
const MOVED_M = 20;
const MOVING_MPS = 0.8;

/**
 * Whether the car has stood for a long while — parked with the page open,
 * which in a car is hours: the polls that follow the car (what is near, a
 * quicker route) find nothing new, and each is a request through the tunnel.
 */
export class Stillness {
  private anchor: LonLat | null = null;
  private movedAt: number;

  constructor(now = Date.now()) {
    this.movedAt = now;
  }

  feed(at: LonLat, speedMps: number | null | undefined, now = Date.now()) {
    const moving = (speedMps != null && speedMps > MOVING_MPS) || !this.anchor || metres(this.anchor[0], this.anchor[1], at[0], at[1]) > MOVED_M;
    if (moving) {
      this.anchor = at;
      this.movedAt = now;
    }
  }

  still(now = Date.now()): boolean {
    return now - this.movedAt > STILL_AFTER_MS;
  }
}
