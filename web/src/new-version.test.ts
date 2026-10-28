import { test } from "node:test";
import assert from "node:assert/strict";
import { RELOAD_STILL_MS, RELOAD_UNTOUCHED_MS, quietEnough } from "./new-version";

test("a new version is loaded only with no drive, the car still and the screen let be, the voice silent", () => {
  const quiet = { driving: false, stillMs: RELOAD_STILL_MS, untouchedMs: RELOAD_UNTOUCHED_MS, speaking: false };
  assert.ok(quietEnough(quiet));
  assert.ok(!quietEnough({ ...quiet, driving: true }), "a route: its voice could need a tap after the reload");
  assert.ok(!quietEnough({ ...quiet, stillMs: 30_000 }), "a red light without a route");
  assert.ok(!quietEnough({ ...quiet, untouchedMs: 5_000 }), "someone at the screen");
  assert.ok(!quietEnough({ ...quiet, speaking: true }));
});
