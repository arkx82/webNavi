import { test } from "node:test";
import assert from "node:assert/strict";
import { carCorners, CAR_LENGTH_M, CAR_WIDTH_M } from "./car-icon";
import { bearing, metres } from "./geo";
import type { LonLat } from "./types";

test("the car's corners are its length and width apart on the ground, its front the way it heads", () => {
  const at: LonLat = [127.0505, 37.7015];
  for (const heading of [0, 29, 90, 200]) {
    const [fl, fr, br, bl] = carCorners(at, heading, CAR_WIDTH_M, CAR_LENGTH_M);
    const d = (a: LonLat, b: LonLat) => metres(a[0], a[1], b[0], b[1]);
    assert.ok(Math.abs(d(fl, fr) - CAR_WIDTH_M) < 0.01, `width ${d(fl, fr)}`);
    assert.ok(Math.abs(d(fr, br) - CAR_LENGTH_M) < 0.01, `length ${d(fr, br)}`);
    assert.ok(Math.abs(d(bl, fl) - CAR_LENGTH_M) < 0.01);
    // From the back to the front: the heading; the front's right corner on the right.
    const way = bearing(bl[0], bl[1], fl[0], fl[1]);
    assert.ok(Math.abs(((way - heading + 540) % 360) - 180) < 0.5, `${way} vs ${heading}`);
    const side = bearing(fl[0], fl[1], fr[0], fr[1]);
    assert.ok(Math.abs(((side - heading - 90 + 540) % 360) - 180) < 0.5, `${side}`);
  }
});

test("the car is as wide as its lane, mirror to mirror, its length in proportion, never under its true size, and never thinner than the floor asked", async () => {
  const { carScale, LANE_WIDTH_M } = await import("./car-icon");
  // The drawing, 2.14 m across the mirrors, in a 3.2 m town lane: 1.5 times its size, 7.4 m long.
  const town = carScale(2.14, LANE_WIDTH_M.town);
  assert.ok(Math.abs(2.14 * town - 3.2) < 1e-9);
  assert.ok(Math.abs(CAR_LENGTH_M * town - 7.44) < 0.01, `${CAR_LENGTH_M * town}`);
  // A motorway's 3.5 m lane: a little bigger again.
  assert.ok(carScale(2.14, LANE_WIDTH_M.motorway) > town);
  // A picture already wider than the lane is left at its true size, not shrunk.
  assert.equal(carScale(4, 3.2), 1);
  // Drawn back at speed the floor (the route line's edge and a little, 6 m on the ground here) is wider than the lane: it holds.
  assert.ok(Math.abs(2.14 * carScale(2.14, 3.2, 6) - 6) < 1e-9);
  // Standing, a floor narrower than the lane changes nothing.
  assert.equal(carScale(2.14, 3.2, 2.5), town);
});
