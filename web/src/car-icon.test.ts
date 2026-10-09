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
