import { test } from "node:test";
import assert from "node:assert/strict";
import { Line, metres, offset } from "./geo";
import { OFF_M, OFF_S, LOST_S, Tracker } from "./tracker";
import type { Fix } from "./gps";
import type { LonLat, Route } from "./types";

// A straight road 2 km due north from Gangnam, one vertex every 100 m.
const start: LonLat = [127.0276, 37.4979];
const path: LonLat[] = Array.from({ length: 21 }, (_, i) => offset(start, 0, i * 100));
const route: Route = {
  provider: "tmap", distanceM: 2000, durationS: 240, path,
  guides: [
    { at: path[5], text: "500m 앞 우회전", distanceM: 500, turnType: 12 },
    { at: path[15], text: "목적지 근처", distanceM: 0, turnType: 201 },
  ],
  segments: [{ from: 0, to: 21, congestion: 1 }],
};

function fix(at: LonLat, t: number, extra: Partial<Fix> = {}): Fix {
  return { t, lon: at[0], lat: at[1], accM: 10, speed: 15, heading: 0, course: 0, ...extra };
}

test("Line projects onto the nearest segment and measures along it", () => {
  const line = new Line(path);
  assert.ok(Math.abs(line.lengthM - 2000) < 2);
  const p = line.project(offset(offset(start, 0, 250), 90, 8));
  assert.ok(Math.abs(p.alongM - 250) < 1, `${p.alongM}`);
  assert.ok(Math.abs(p.offM - 8) < 0.5, `${p.offM}`);
  assert.equal(p.segment, 2);
  assert.ok(Math.abs(p.bearing - 0) < 0.5);
  const back = line.place(1234);
  assert.ok(metres(back.at[0], back.at[1], offset(start, 0, 1234)[0], offset(start, 0, 1234)[1]) < 1);
});

test("a fix beside the road is drawn on the road, with the road's bearing", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  const now = 1000;
  tracker.feed(fix(offset(offset(start, 0, 300), 90, 10), now, { course: 5 }), now);
  const shown = tracker.frame(now + 2000)!;
  assert.equal(shown.mode, "gps");
  const onRoad = offset(start, 0, 300);
  assert.ok(metres(shown.at[0], shown.at[1], onRoad[0], onRoad[1]) < 1);
  assert.ok(Math.abs(shown.bearing) < 0.5);
  assert.equal(shown.nextGuide?.guide.text, "500m 앞 우회전");
  assert.ok(Math.abs(shown.nextGuide!.inM - 200) < 2);
  assert.ok(Math.abs(shown.remainingM! - 1700) < 2);
});

test("the marker glides between fixes rather than jumping", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  tracker.feed(fix(offset(start, 0, 300), 0), 0);
  tracker.frame(1000);
  tracker.feed(fix(offset(start, 0, 315), 1000), 1000);
  const half = tracker.frame(1500)!;
  const d = metres(half.at[0], half.at[1], offset(start, 0, 300)[0], offset(start, 0, 300)[1]);
  assert.ok(d > 5 && d < 10, `${d}`);
});

test("one bad fix is not off-route; three seconds off the road is", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  const calls: LonLat[] = [];
  tracker.onOffRoute = (at) => calls.push(at);
  tracker.feed(fix(offset(start, 0, 300), 0), 0);
  const wide = offset(offset(start, 0, 400), 90, OFF_M + 20);
  tracker.feed(fix(wide, 1000), 1000);
  assert.equal(calls.length, 0);
  tracker.feed(fix(wide, 2000), 2000);
  tracker.feed(fix(wide, 1000 + OFF_S * 1000), 1000 + OFF_S * 1000);
  assert.equal(calls.length, 1);
  assert.equal(tracker.frame(5000)!.offRoute, true);
});

test("a car on a parallel street pointing the other way is not snapped", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  const beside = offset(offset(start, 0, 300), 90, 20);
  tracker.feed(fix(beside, 0, { course: 180, heading: 180 }), 0);
  const shown = tracker.frame(1000)!;
  assert.ok(metres(shown.at[0], shown.at[1], beside[0], beside[1]) < 1);
});

test("in a tunnel the marker keeps going along the route at the last speed", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  tracker.feed(fix(offset(start, 0, 500), 0, { speed: 20 }), 0);
  tracker.frame(500);
  const later = (LOST_S + 3) * 1000;
  const shown = tracker.frame(later)!;
  assert.equal(shown.mode, "reckoning");
  const expected = offset(start, 0, 500 + 20 * (later / 1000));
  assert.ok(metres(shown.at[0], shown.at[1], expected[0], expected[1]) < 2);
  // Out the other side: the next fix slides the marker over 1.5 s, not at once.
  tracker.feed(fix(offset(start, 0, 700), later, { speed: 20 }), later);
  assert.equal(tracker.frame(later + 500)!.mode, "snapping");
  assert.equal(tracker.frame(later + 1600)!.mode, "gps");
});

test("without a route, fixes glide and reckoning goes straight on", () => {
  const tracker = new Tracker();
  tracker.feed(fix(start, 0, { speed: 10, course: 90 }), 0);
  tracker.frame(100);
  const shown = tracker.frame(4000)!;
  assert.equal(shown.mode, "reckoning");
  const expected = offset(start, 90, 40);
  assert.ok(metres(shown.at[0], shown.at[1], expected[0], expected[1]) < 2);
});
