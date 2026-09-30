import { test } from "node:test";
import assert from "node:assert/strict";
import { offset } from "./geo";
import { RESUME_MIN_M, worthResuming, type DriveState } from "./resume";
import type { LonLat } from "./types";

const goal: LonLat = [127.0489, 37.5045];
const drive: DriveState = { to: { name: "선릉역", address: "", at: goal }, provider: "tmap", at: Date.now() };

test("a drive closed just short of its destination is not taken up again (it would announce the arrival twice)", () => {
  assert.equal(worthResuming(drive, offset(goal, 0, RESUME_MIN_M - 30)), false);
  assert.equal(worthResuming(drive, goal), false);
  assert.equal(worthResuming(drive, offset(goal, 0, RESUME_MIN_M + 50)), true);
  // Where the car is not yet known, the drive is kept: the fix may come later.
  assert.equal(worthResuming(drive, null), true);
});
