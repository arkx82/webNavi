import { test } from "node:test";
import assert from "node:assert/strict";
import { korean } from "./osrm.js";

test("OSRM manoeuvres come out as the phrases car apps say", () => {
  assert.equal(korean("turn", "right", undefined, "테헤란로"), "테헤란로 방면 우회전");
  assert.equal(korean("turn", "left"), "좌회전");
  assert.equal(korean("roundabout", "right", 2), "회전교차로에서 2번째 출구");
  assert.equal(korean("off ramp", "slight right", undefined, "올림픽대로"), "올림픽대로 방면 오른쪽 출구");
  assert.equal(korean("end of road", "left"), "길 끝에서 좌회전");
  assert.equal(korean("arrive"), "목적지 도착");
});
