import { test } from "node:test";
import assert from "node:assert/strict";
import { trafficStops } from "./traffic-bar";
import { COLOURS } from "./route-layer";

test("the bar's colours run foot to top by distance, the stretches without traffic the route blue, runs of one colour as one", () => {
  // Five points 0, 100, 200, 300, 1000 m along.
  const along = [0, 100, 200, 300, 1000];
  const path = along.map((m) => [127, 37 + m / 111_320] as [number, number]);
  const stops = trafficStops({ path, segments: [{ from: 1, to: 2, congestion: 1 }, { from: 2, to: 3, congestion: 1 }, { from: 3, to: 4, congestion: 3 }] }, along);
  assert.equal(stops, [
    `${COLOURS[0]} 0.00%, ${COLOURS[0]} 10.00%`,
    `${COLOURS[1]} 10.00%, ${COLOURS[1]} 30.00%`,
    `${COLOURS[3]} 30.00%, ${COLOURS[3]} 100.00%`,
  ].join(", "));
  // No length: one colour, nothing divided by nothing.
  assert.equal(trafficStops({ path: [path[0]], segments: [] }, [0]), `${COLOURS[0]} 0%, ${COLOURS[0]} 100%`);
});
