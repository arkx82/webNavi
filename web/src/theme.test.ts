import { test } from "node:test";
import assert from "node:assert/strict";
import { isNight, sunAltitude } from "./theme";

const seoul: [number, number] = [126.978, 37.5665];

test("in Seoul the sun is high at noon, down at midnight, and night comes after sunset", () => {
  const at = (iso: string) => Date.parse(iso);
  assert.ok(sunAltitude(at("2026-06-21T12:30:00+09:00"), seoul) > 70);
  assert.ok(sunAltitude(at("2026-06-21T00:30:00+09:00"), seoul) < -20);
  // 30 September: sunrise about 06:25, sunset about 18:20.
  assert.ok(!isNight(at("2026-09-30T07:00:00+09:00"), seoul));
  assert.ok(!isNight(at("2026-09-30T18:00:00+09:00"), seoul));
  assert.ok(isNight(at("2026-09-30T19:00:00+09:00"), seoul));
  assert.ok(isNight(at("2026-09-30T05:40:00+09:00"), seoul));
});
