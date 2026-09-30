import { test } from "node:test";
import assert from "node:assert/strict";
import { ASK_AGAIN_M, ASK_AGAIN_MS, CAMERAS_MIN_ZOOM, shouldAsk } from "./camera-layer";
import type { LonLat } from "./types";

const seoul: LonLat = [126.978, 37.5665];
/** [m] metres east of Seoul's middle. */
const east = (m: number): LonLat => [seoul[0] + m / (111_320 * Math.cos((seoul[1] * Math.PI) / 180)), seoul[1]];
const now = 1_700_000_000_000;

test("the cameras are asked for once, then only after the middle has moved far enough or long enough has passed", () => {
  // Never asked: asked now, but not drawn back too far to show any.
  assert.equal(shouldAsk({ askedAt: null, askedWhen: 0, at: seoul, zoom: CAMERAS_MIN_ZOOM }, now), true);
  assert.equal(shouldAsk({ askedAt: null, askedWhen: 0, at: seoul, zoom: CAMERAS_MIN_ZOOM - 1 }, now), false);
  // Following the car: the middle creeps every frame, and nothing is asked until it has gone ASK_AGAIN_M.
  const asked = { askedAt: seoul, askedWhen: now, zoom: 16 };
  assert.equal(shouldAsk({ ...asked, at: east(50) }, now + 2000), false);
  assert.equal(shouldAsk({ ...asked, at: east(ASK_AGAIN_M - 20) }, now + 2000), false);
  assert.equal(shouldAsk({ ...asked, at: east(ASK_AGAIN_M + 20) }, now + 2000), true);
  // Parked: asked again once the last answer is old.
  assert.equal(shouldAsk({ ...asked, at: seoul }, now + ASK_AGAIN_MS - 1), false);
  assert.equal(shouldAsk({ ...asked, at: seoul }, now + ASK_AGAIN_MS), true);
  // Drawn far back, moved or not: nothing would be shown, so nothing is asked.
  assert.equal(shouldAsk({ ...asked, at: east(5000), zoom: 10 }, now + ASK_AGAIN_MS), false);
});
