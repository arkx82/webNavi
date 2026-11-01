import { test } from "node:test";
import assert from "node:assert/strict";
import { Gps, type Fix } from "./gps";

test("a browser heading against the way the fixes go is not taken: 0° said at 60 km/h going south-west (2026-11-01)", () => {
  const gps = new Gps();
  const k = 111_320, kx = k * Math.cos((37.5169 * Math.PI) / 180);
  const way = 207, v = 16.4;
  const fixes: Fix[] = [];
  for (let i = 0; i < 40; i++) {
    const m = i * v * 0.25;
    const heading = i >= 30 ? 0 : way; // the last 10: north, though the car goes on south-west
    const fix: Fix = { t: 1_000_000 + i * 250, lon: 126.9584 + (m * Math.sin((way * Math.PI) / 180)) / kx, lat: 37.5169 + (m * Math.cos((way * Math.PI) / 180)) / k, accM: 1.9, speed: v, heading, course: null };
    gps.feed(fix);
    fixes.push(fix);
  }
  for (const f of fixes.slice(30)) assert.ok(Math.abs(f.course! - way) < 3, `course ${f.course}`);
  // A heading that agrees is the browser's own.
  assert.equal(fixes[20].course, way);
});
