import { test } from "node:test";
import assert from "node:assert/strict";
import { offset } from "./geo";
import { STILL_AFTER_MS, Stillness } from "./still";
import type { LonLat } from "./types";

const here: LonLat = [127.0276, 37.4979];

test("parked for more than five minutes is still, whatever the fixes wander; a move (or a speed) ends it", () => {
  const s = new Stillness(0);
  s.feed(here, 0, 0);
  for (let t = 1000; t <= STILL_AFTER_MS; t += 1000) s.feed(offset(here, t % 360, 8), 0, t);
  assert.equal(s.still(STILL_AFTER_MS), false);
  assert.equal(s.still(STILL_AFTER_MS + 2000), true);
  // No speed from the browser, but the car is 30 m from where it stood.
  s.feed(offset(here, 90, 30), null, STILL_AFTER_MS + 3000);
  assert.equal(s.still(STILL_AFTER_MS + 4000), false);
  // Standing again, the browser saying so: still after another five minutes; a speed alone ends it.
  const at = offset(here, 90, 30);
  for (let t = 4000; t <= STILL_AFTER_MS + 5000; t += 1000) s.feed(at, 0, STILL_AFTER_MS + t);
  assert.equal(s.still(2 * STILL_AFTER_MS + 6000), true);
  s.feed(at, 3, 2 * STILL_AFTER_MS + 7000);
  assert.equal(s.still(2 * STILL_AFTER_MS + 8000), false);
});
