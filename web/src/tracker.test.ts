import { test } from "node:test";
import assert from "node:assert/strict";
import { Line, metres, offset } from "./geo";
import { OFF_AGAIN_S, OFF_FAR_M, OFF_M, OFF_S, LOST_S, Tracker, type ReckonEnd } from "./tracker";
import { CarTrack } from "./car-track";
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

// ---- the car's own speed (car-track.ts) in a tunnel ----

/** A car that streams: [speedAt] its speed through time, a sample a second from [from] to [to], 300 ms on the way. */
function carFeed(speedAt: (t: number) => number, from: number, to: number): CarTrack {
  const car = new CarTrack();
  for (let t = from; t <= to; t += 1000) car.add({ t, speedMps: speedAt(t) }, t + 300);
  return car;
}

test("a jam in the tunnel: the car's own speed stands the marker still, not carried on at the speed it went in at", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  // In at 20 m/s, down to standing in five seconds, standing two minutes.
  tracker.car = carFeed((t) => (t < 5000 ? 20 - 4 * (t / 1000) : 0), 0, 130_000);
  tracker.feed(fix(offset(start, 0, 300), 0, { speed: 20 }), 0);
  const in60 = tracker.frame(60_000)!;
  assert.equal(in60.mode, "reckoning");
  assert.equal(in60.reckonBy, "car");
  // 20 → 0 over five seconds is about 60 m (the held steps a little more): not the 1200 the last speed would make.
  assert.ok(in60.alongM! > 340 && in60.alongM! < 380, `${in60.alongM}`);
  assert.equal(in60.speedMps, 0);
  const in120 = tracker.frame(120_000)!;
  assert.ok(Math.abs(in120.alongM! - in60.alongM!) < 0.01, "still standing");
});

test("a car that went into the tunnel slowly is still reckoned, on its own speed", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  // In at 2 m/s (below the floor a fix's speed needs), then away at 15.
  tracker.car = carFeed((t) => (t < 10_000 ? 2 : 15), 0, 40_000);
  tracker.feed(fix(offset(start, 0, 300), 0, { speed: 2 }), 0);
  const shown = tracker.frame(30_000)!;
  assert.equal(shown.mode, "reckoning");
  assert.ok(Math.abs(shown.alongM! - (300 + 2 * 10 + 15 * 20)) < 20, `${shown.alongM}`);
});

test("the link gone too, mid-tunnel: from where the car last said, at the speed it last said", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  // 10 m/s, the samples stopping at 20 s.
  tracker.car = carFeed(() => 10, 0, 20_000);
  tracker.feed(fix(offset(start, 0, 100), 0, { speed: 25 }), 0);
  const shown = tracker.frame(40_000)!;
  assert.equal(shown.mode, "reckoning");
  // 10 m/s throughout (the car's, not the fix's 25): 400 m on.
  assert.ok(Math.abs(shown.alongM! - 500) < 5, `${shown.alongM}`);
});

test("out of the tunnel the marker slides to the fix, never leaps, and the miss is told", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  const ends: ReckonEnd[] = [];
  tracker.onReckonEnd = (r) => ends.push(r);
  tracker.feed(fix(offset(start, 0, 300), 0, { speed: 20 }), 0);
  for (let t = 0; t <= 20_000; t += 16) tracker.frame(t);
  // Reckoned at 20 m/s to about 700 m; the car had slowed and is at 550.
  tracker.feed(fix(offset(start, 0, 550), 20_000, { speed: 10 }), 20_000);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].by, "speed");
  assert.ok(Math.abs(ends[0].errorM! - -150) < 5, `${ends[0].errorM}`);
  // Where the car is drawn, metres up the (straight, northward) road.
  const drawn = (t: number) => { const at = tracker.frame(t)!.at; return metres(start[0], start[1], at[0], at[1]); };
  let was = drawn(20_000);
  assert.ok(Math.abs(was - 700) < 5, `${was}`);
  let most = 0;
  for (let t = 20_016; t <= 22_000; t += 16) {
    const along = drawn(t);
    most = Math.max(most, Math.abs(along - was));
    was = along;
  }
  assert.ok(most < 5, `largest step a frame ${most} m`);
  assert.ok(Math.abs(was - (550 + 10 * 2)) < 5, `${was}`);
});

// ---- off the road, on the car's heading ----

test("no route, the fixes gone (a car park): the car goes the way its own estimate goes, and slides back to the fix", () => {
  const tracker = new Tracker();
  const ends: ReckonEnd[] = [];
  tracker.onReckonEnd = (r) => ends.push(r);
  const car = new CarTrack();
  // 5 m/s due north, the car's estimate keeping up.
  for (let t = 0; t <= 30_000; t += 1000) car.add({ t, speedMps: 5, est: { lon: start[0], lat: offset(start, 0, 5 * (t / 1000))[1], heading: 0 } }, t + 300);
  tracker.car = car;
  tracker.feed(fix(start, 0, { speed: 5 }), 0);
  const shown = tracker.frame(20_000)!;
  assert.equal(shown.mode, "reckoning");
  assert.equal(shown.reckonBy, "car");
  assert.ok(Math.abs(metres(start[0], start[1], shown.at[0], shown.at[1]) - 100) < 3, `${metres(start[0], start[1], shown.at[0], shown.at[1])}`);
  tracker.feed(fix(offset(start, 0, 110), 22_000, { speed: 5 }), 22_000);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].free, true);
  assert.ok(ends[0].errorM! < 15, `${ends[0].errorM}`);
});

test("no route, the car's heading and estimate both frozen: held where it was, not sent straight on", () => {
  const tracker = new Tracker();
  const car = new CarTrack();
  for (let t = 0; t <= 30_000; t += 1000) car.add({ t, speedMps: 5, est: { lon: start[0], lat: start[1], heading: 0 } }, t + 300);
  tracker.car = car;
  tracker.feed(fix(start, 0, { speed: 5 }), 0);
  const shown = tracker.frame(20_000)!;
  assert.notEqual(shown.mode, "reckoning");
  assert.ok(metres(start[0], start[1], shown.at[0], shown.at[1]) < 2);
});

test("no route, heading and estimate frozen but the car at a road's pace (a straight tunnel): carried straight on, not left at the mouth", () => {
  const tracker = new Tracker();
  const car = new CarTrack();
  for (let t = 0; t <= 30_000; t += 1000) car.add({ t, speedMps: 15, est: { lon: start[0], lat: start[1], heading: 0 } }, t + 300);
  tracker.car = car;
  tracker.feed(fix(start, 0, { speed: 15 }), 0);
  const shown = tracker.frame(20_000)!;
  assert.equal(shown.mode, "reckoning");
  const ahead = offset(start, 0, 300);
  assert.ok(metres(ahead[0], ahead[1], shown.at[0], shown.at[1]) < 10, `${metres(ahead[0], ahead[1], shown.at[0], shown.at[1])}`);
});

test("vague fixes while the car says it moves are not taken to hold it: the reckoning on the car's word goes on", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  tracker.car = carFeed(() => 10, 0, 40_000);
  tracker.feed(fix(offset(start, 0, 300), 0, { speed: 10 }), 0);
  // A garage's wandering fixes, no speed said.
  for (let t = 1000; t <= 20_000; t += 1000) tracker.feed(fix(offset(start, 90, 60), t, { speed: null, heading: null, course: null, accM: 80 }), t);
  const shown = tracker.frame(20_000)!;
  assert.equal(shown.mode, "reckoning");
  assert.ok(Math.abs(shown.alongM! - 500) < 15, `${shown.alongM}`);
});

test("parked by the car's own gear: the fixes' wander neither moves the marker nor turns it", () => {
  const tracker = new Tracker();
  const car = new CarTrack();
  // The owner streaming parked: every 3 s, the gear blank or P, no speed, its heading wandering with the GPS.
  for (let t = 0; t <= 60_000; t += 3000) car.add({ t, speedMps: null, gear: t % 6000 ? "P" : null, est: { lon: start[0], lat: start[1], heading: (t / 100) % 360 } }, t + 300);
  tracker.car = car;
  tracker.feed(fix(start, 0, { speed: 0, course: null, accM: 12 }), 0);
  const first = tracker.frame(100)!;
  // Fixes every 8 s, 15 m about in every direction, with a jittered speed and course of their own.
  for (let t = 8000; t <= 56_000; t += 8000) {
    tracker.feed(fix(offset(start, (t / 40) % 360, 15), t, { speed: 1.8, course: (t / 30) % 360, accM: 13 }), t);
    for (let f = t; f < t + 8000; f += 500) {
      const shown = tracker.frame(f)!;
      assert.notEqual(shown.mode, "reckoning");
      assert.ok(metres(start[0], start[1], shown.at[0], shown.at[1]) < 0.5, `moved at ${f}`);
      assert.equal(shown.bearing, first.bearing, `turned at ${f}`);
    }
  }
  // A sharper fix refines the place, still without turning it.
  tracker.feed(fix(offset(start, 90, 4), 58_000, { speed: 1.8, course: 200, accM: 4 }), 58_000);
  const refined = tracker.frame(62_000)!;
  assert.ok(Math.abs(metres(start[0], start[1], refined.at[0], refined.at[1]) - 4) < 0.5);
  assert.equal(refined.bearing, first.bearing);
});

test("out of P the fixes are followed again at once", () => {
  const tracker = new Tracker();
  const car = new CarTrack();
  for (let t = 0; t <= 9000; t += 3000) car.add({ t, speedMps: null, gear: "P" }, t + 300);
  tracker.car = car;
  tracker.feed(fix(start, 0, { speed: 0, accM: 12 }), 0);
  tracker.feed(fix(offset(start, 0, 15), 8000, { speed: 0, accM: 12 }), 8000);
  const held = tracker.frame(9000)!.at;
  assert.ok(metres(start[0], start[1], held[0], held[1]) < 0.5);
  car.add({ t: 10_000, speedMps: 0, gear: "D" }, 10_300);
  tracker.feed(fix(offset(start, 0, 15), 11_000, { speed: 0, accM: 12 }), 11_000);
  const at = tracker.frame(14_000)!.at;
  assert.ok(Math.abs(metres(start[0], start[1], at[0], at[1]) - 15) < 0.5);
});

test("on the route, the fixes gone and no reckoning (too slow): carried PREDICT_S on, then held, not crept on", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  tracker.feed(fix(offset(start, 0, 300), 0, { speed: 2 }), 0);
  for (let t = 0; t <= 60_000; t += 16) tracker.frame(t);
  const shown = tracker.frame(60_016)!;
  assert.notEqual(shown.mode, "reckoning");
  // 2 m/s for 2.5 s: 5 m on, no more.
  assert.ok(shown.alongM! < 306 && metres(start[0], start[1], shown.at[0], shown.at[1]) < 306, `${metres(start[0], start[1], shown.at[0], shown.at[1])}`);
});

test("on the route, parked with the fixes gone: the speed it came in at is not carried on", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  const car = new CarTrack();
  tracker.car = car;
  tracker.feed(fix(offset(start, 0, 300), 0, { speed: 12 }), 0);
  for (let t = 0; t <= 60_000; t += 16) {
    if (t % 3000 === 0) car.add({ t, speedMps: null, gear: "P" }, t + 300);
    tracker.frame(t);
  }
  const at = tracker.frame(60_016)!.at;
  assert.ok(metres(start[0], start[1], at[0], at[1]) < 301, `${metres(start[0], start[1], at[0], at[1])}`);
});

test("reckoned into a car park and put in P there: it stays where it was reckoned to, not back at the entrance", () => {
  const tracker = new Tracker();
  tracker.setRoute(route);
  const car = new CarTrack();
  tracker.car = car;
  tracker.feed(fix(offset(start, 0, 300), 0, { speed: 10 }), 0);
  // 10 m/s for 5 s into the dark, then standing in P.
  for (let t = 0; t <= 5000; t += 1000) car.add({ t, speedMps: 10 }, t + 300);
  for (let t = 0; t <= 5000; t += 16) tracker.frame(t);
  const reckoned = tracker.frame(5000)!.alongM!;
  assert.ok(reckoned > 340, `${reckoned}`);
  let most = 0, was = reckoned;
  for (let t = 5016; t <= 30_000; t += 16) {
    if (t % 3000 < 16) car.add({ t, speedMps: null, gear: "P" }, t + 300);
    const at = tracker.frame(t)!.at;
    const along = metres(start[0], start[1], at[0], at[1]);
    most = Math.max(most, Math.abs(along - was));
    was = along;
  }
  assert.ok(most < 2, `largest step a frame ${most} m`);
  assert.ok(Math.abs(was - reckoned) < 15, `${was} vs ${reckoned}`);
  // A vague fix from the car park does not take it back either.
  tracker.feed(fix(offset(start, 0, 300), 31_000, { speed: 0, accM: 20 }), 31_000);
  const at = tracker.frame(33_000)!.at;
  assert.ok(Math.abs(metres(start[0], start[1], at[0], at[1]) - was) < 1);
});

test("guides that name no choice are passed over: the next shown is the turn that matters", () => {
  const tracker = new Tracker();
  tracker.quiet = (g) => g.text === "12시 방향";
  tracker.setRoute({ ...route, guides: [
    { at: path[3], text: "12시 방향", distanceM: 0, turnType: 29 },
    { at: path[6], text: "12시 방향", distanceM: 0, turnType: 29 },
    { at: path[12], text: "오른쪽 출구", distanceM: 0, turnType: 9 },
  ] });
  tracker.feed(fix(offset(start, 0, 100), 0, { speed: 20 }), 0);
  const shown = tracker.frame(0)!;
  assert.equal(shown.nextGuide?.guide.text, "오른쪽 출구");
  assert.ok(Math.abs(shown.nextGuide!.inM - 1100) < 5, `${shown.nextGuide!.inM}`);
  assert.equal(shown.thenGuide, undefined);
});

test("a new route while the fixes are away (a re-route, a quicker way taken): reckoned from where the car is on it, not as far along as it was on the old one", () => {
  // 2026-10-03 on the road: the route changed between two of the car browser's sparse fixes, and the marker leapt
  // 1583 m on along the new line — the old route's metres along, laid on the new one.
  const tracker = new Tracker();
  tracker.setRoute(route);
  tracker.car = carFeed(() => 10, 0, 30_000);
  const here = offset(start, 0, 1500);
  tracker.feed(fix(here, 0, { speed: 10 }), 0);
  tracker.frame(500);
  // From where the car is, east for 2 km.
  const east: Route = { ...route, path: Array.from({ length: 21 }, (_, i) => offset(here, 90, i * 100)), guides: [], segments: [] };
  tracker.setRoute(east);
  const shown = tracker.frame(5000)!;
  assert.equal(shown.mode, "reckoning");
  assert.ok(shown.alongM! < 80, `along the new route ${shown.alongM} m, the car having gone 50 m`);
  assert.ok(metres(shown.at[0], shown.at[1], here[0], here[1]) < 80);
});
