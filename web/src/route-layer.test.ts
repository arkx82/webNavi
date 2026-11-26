import { test } from "node:test";
import assert from "node:assert/strict";
import { BAND_LANE_M, bandStops } from "./route-layer";

test("the 차선 띠 is a lane wide on the ground, and never narrower than the route line drawn back", () => {
  const stops = new Map(bandStops(37.5));
  // Zoom 19 at Seoul: 0.12 m a pixel, so a lane of 3.3 m is about 27 px.
  const mPerPx = (z: number) => (40_075_016.686 * Math.cos((37.5 * Math.PI) / 180)) / (512 * 2 ** z);
  assert.ok(Math.abs(stops.get(19)! - BAND_LANE_M / mPerPx(19)) < 0.1);
  // Each level in is twice as wide, where the lane is wider than the line.
  assert.ok(Math.abs(stops.get(20)! / stops.get(19)! - 2) < 0.01);
  // Drawn back (zoom 14) a lane is under a pixel: the band is the line's width and a pixel.
  // (the line is 6.25 px there: 4 at 11, 7 at 15)
  assert.equal(stops.get(14), 7.3);
});
