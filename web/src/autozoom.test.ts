import { test } from "node:test";
import assert from "node:assert/strict";
import { TURN_ZOOM, autoZoom, zoomForSpeed } from "./autozoom";

test("the camera pulls back as the car speeds up, and no further than the table", () => {
  let last = Infinity;
  for (let kmh = 0; kmh <= 160; kmh += 10) {
    const z = zoomForSpeed(kmh);
    assert.ok(z <= last, `${kmh} km/h zoomed in again`);
    last = z;
  }
  assert.equal(zoomForSpeed(-5), zoomForSpeed(0));
  assert.equal(zoomForSpeed(200), zoomForSpeed(130));
  assert.ok(Math.abs(zoomForSpeed(50) - (17.9 + 17.4) / 2) < 1e-9);
});

test("a turn close ahead draws the camera in, a far one not at all", () => {
  assert.equal(autoZoom(60, 5000), zoomForSpeed(60));
  assert.equal(autoZoom(60, undefined), zoomForSpeed(60));
  assert.ok(Math.abs(autoZoom(60, 0) - (zoomForSpeed(60) + TURN_ZOOM)) < 1e-9);
  assert.ok(autoZoom(60, 100) > autoZoom(60, 200));
  assert.equal(autoZoom(60, 5000, -0.5), zoomForSpeed(60) - 0.5);
});
