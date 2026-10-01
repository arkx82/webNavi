import { test } from "node:test";
import assert from "node:assert/strict";
import { Line, metres, offset } from "./geo";
import { OFF_AGAIN_S, OFF_FAR_M, OFF_M, OFF_S, LOST_S, Tracker } from "./tracker";
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
  // On the road (not 10 m beside it), carried on at its 15 m/s for the two seconds since the fix: 30 m past where
  // the fix sat on the road, where the car is by now.
  const onRoad = offset(start, 0, 330);
  assert.ok(metres(shown.at[0], shown.at[1], onRoad[0], onRoad[1]) < 1, `${metres(shown.at[0], shown.at[1], onRoad[0], onRoad[1])}`);
  assert.ok(Math.abs(shown.bearing) < 0.5);
  assert.equal(shown.nextGuide?.guide.text, "500m 앞 우회전");
  assert.ok(Math.abs(shown.remainingM! - 1700) < 2, "what is ahead is counted from the fix's place, not the drawn car's");
});

test("the marker moves on at the car's speed between fixes, never stopping or jumping", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  tracker.feed(fix(offset(start, 0, 300), 0), 0);
  const along = (at: LonLat) => metres(at[0], at[1], start[0], start[1]);
  // Frame by frame through the second: every step forward, each about the 15 m/s the car does.
  let last = along(tracker.frame(16)!.at);
  for (let t = 32; t <= 1000; t += 16) {
    const a = along(tracker.frame(t)!.at);
    assert.ok(a > last && a - last < 0.6, `${t}: ${a - last}`);
    last = a;
  }
  // The next fix a little short of where the car was carried: no jump back, the gap melts over the next frames.
  tracker.feed(fix(offset(start, 0, 312), 1000), 1000);
  const before = along(tracker.frame(1000)!.at);
  const after = along(tracker.frame(1016)!.at);
  assert.ok(after > before - 1 && after < before + 1, `${after - before}`);
  // And a second on, frame by frame, the car is where the fixes say: 15 m/s past the 312 m fix, give or take.
  let later = 0;
  for (let t = 1032; t <= 2000; t += 16) later = along(tracker.frame(t)!.at);
  assert.ok(Math.abs(later - 327) < 4, `${later}`);
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

test("without a route, a lost signal holds the car where it was, not sent off in a straight line", () => {
  const tracker = new Tracker();
  tracker.feed(fix(start, 0, { speed: 10, course: 90 }), 0);
  tracker.frame(100);
  const shown = tracker.frame(4000)!;
  assert.notEqual(shown.mode, "reckoning");
  assert.ok(metres(shown.at[0], shown.at[1], start[0], start[1]) < 2);
});

test("parked with a vague signal (a garage), the wandering fixes do not move the car or make a speed", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  tracker.feed(fix(offset(start, 0, 300), 0, { speed: 0, accM: 12 }), 0);
  // Fixes 30–60 m out in every direction, no speed from the browser, poor accuracy.
  for (let i = 1; i <= 20; i++) {
    tracker.feed(fix(offset(offset(start, 0, 300), (i * 77) % 360, 30 + (i % 3) * 15), i * 1000, { speed: null, heading: null, course: null, accM: 80 }), i * 1000);
  }
  const shown = tracker.frame(21_000)!;
  assert.ok(metres(shown.at[0], shown.at[1], offset(start, 0, 300)[0], offset(start, 0, 300)[1]) < 5, "still where it parked");
  assert.equal(shown.speedMps, 0);
  assert.notEqual(shown.mode, "reckoning");
});

test("in a long tunnel the car goes on along the route at the traffic's pace, and stops only after a tunnel's length of time", () => {
  const tracker = new Tracker();
  // The first kilometre is jammed.
  tracker.setRoute({ ...route, segments: [{ from: 0, to: 10, congestion: 3 }, { from: 10, to: 21, congestion: 1 }] });
  tracker.feed(fix(offset(start, 0, 100), 0, { speed: 20 }), 0);
  const in30s = tracker.frame(30_000)!;
  assert.equal(in30s.mode, "reckoning");
  // At the jam's 3 m/s, not the 20 it last went: about 90 m on, not 600.
  assert.ok(in30s.alongM! > 150 && in30s.alongM! < 250, `${in30s.alongM}`);
  assert.equal(tracker.frame(300_000)!.mode, "reckoning");
  assert.notEqual(tracker.frame(700_000)!.mode, "reckoning");
});

test("well clear of the road on good fixes is off-route after a second", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  const calls: LonLat[] = [];
  tracker.onOffRoute = (at) => calls.push(at);
  tracker.feed(fix(offset(start, 0, 300), 0), 0);
  const far = offset(offset(start, 0, 400), 90, OFF_FAR_M + 30);
  tracker.feed(fix(far, 1000), 1000);
  assert.equal(calls.length, 0);
  tracker.feed(fix(far, 2000), 2000);
  assert.equal(calls.length, 1);
});

test("a fix far out but vague waits the full three seconds", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  const calls: LonLat[] = [];
  tracker.onOffRoute = (at) => calls.push(at);
  const far = offset(offset(start, 0, 400), 90, OFF_FAR_M + 30);
  tracker.feed(fix(far, 1000, { accM: 60 }), 1000);
  tracker.feed(fix(far, 2000, { accM: 60 }), 2000);
  assert.equal(calls.length, 0);
  tracker.feed(fix(far, 1000 + OFF_S * 1000, { accM: 60 }), 1000 + OFF_S * 1000);
  assert.equal(calls.length, 1);
});

test("still off after a re-route that did not come, it is asked again", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  const calls: number[] = [];
  const wide = offset(offset(start, 0, 400), 90, OFF_M + 20);
  for (let t = 0; t <= 20_000; t += 1000) {
    tracker.onOffRoute = () => calls.push(t);
    tracker.feed(fix(wide, t), t);
  }
  assert.deepEqual(calls, [OFF_S * 1000, (OFF_S + OFF_AGAIN_S) * 1000, (OFF_S + 2 * OFF_AGAIN_S) * 1000]);
});

test("the camera looks 2.5 s ahead along the chord, so a bend is turned into as a whole, and never faster than asked", () => {
  // North 500 m, then east 500 m.
  const bent: LonLat[] = [...Array.from({ length: 6 }, (_, i) => offset(start, 0, i * 100)), ...Array.from({ length: 5 }, (_, i) => offset(offset(start, 0, 500), 90, (i + 1) * 100))];
  const tracker = new Tracker();
  tracker.setRoute({ ...route, path: bent, distanceM: 1000 });
  const now = 1_000_000;
  // 480 m along, doing 10 m/s: the lookahead is the 40 m floor, 20 m of it past the corner.
  tracker.feed(fix(offset(start, 0, 480), now, { speed: 10, course: 0 }), now);
  tracker.frame(now);
  const chord = tracker.cameraBearing(0, 1);
  assert.ok(Math.abs(chord - 45) < 2, `chord ${chord}`);
  // The step capped: ten degrees of the forty-five.
  const capped = tracker.cameraBearing(0, 1, 10);
  assert.ok(Math.abs(capped - 10) < 0.01, `capped ${capped}`);
  // Well before the corner the chord is the road's own way.
  tracker.feed(fix(offset(start, 0, 300), now + 1000, { speed: 10, course: 0 }), now + 1000);
  tracker.frame(now + 1000);
  const straight = tracker.cameraBearing(90, 1);
  assert.ok(straight < 1 || straight > 359, `straight ${straight}`);
});
