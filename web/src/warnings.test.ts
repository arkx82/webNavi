import { test } from "node:test";
import assert from "node:assert/strict";
import { offset } from "./geo";
import { RouteWatch, findCurves, phraseFor, type Feature } from "./warnings";
import type { LonLat, Route } from "./types";

const start: LonLat = [127.0276, 37.4979];
// 1 km north, then a right-angle turn east for 1 km, one vertex per 50 m.
const north = Array.from({ length: 21 }, (_, i) => offset(start, 0, i * 50));
const corner = north[20];
const east = Array.from({ length: 20 }, (_, i) => offset(corner, 90, (i + 1) * 50));
const path = [...north, ...east];
const route: Route = {
  provider: "kakao", distanceM: 2000, durationS: 200, path, segments: [],
  guides: [{ at: corner, text: "우회전", distanceM: 1000, turnType: 2 }],
};

test("a camera 10 m beside the road is on it; one 40 m off is another road", () => {
  const watch = new RouteWatch(route);
  const on: Feature = { id: "on", kind: "speed", ...lonLat(offset(offset(start, 0, 700), 90, 10)), limit: 60 };
  const off: Feature = { id: "off", kind: "speed", ...lonLat(offset(offset(start, 0, 700), 90, 40)) };
  watch.add([on, off]);
  const ahead = watch.ahead(100);
  assert.deepEqual(ahead.map((a) => a.feature.id), ["on"]);
  assert.ok(Math.abs(ahead[0].inM - 600) < 2);
});

test("a camera behind the car is not ahead", () => {
  const watch = new RouteWatch(route);
  watch.add([{ id: "b", kind: "bump", ...lonLat(offset(start, 0, 200)) }]);
  assert.equal(watch.ahead(500).length, 0);
});

test("each rung speaks once, in order, as the car closes in", () => {
  const watch = new RouteWatch(route);
  watch.add([{ id: "cam", kind: "speed", ...lonLat(offset(start, 0, 800)), limit: 50 }]);
  assert.equal(watch.due(100).length, 0); // 700 m out: nothing yet
  const first = watch.due(250); // 550 m
  assert.equal(first.length, 1);
  assert.equal(first[0].rungM, 600);
  assert.equal(phraseFor(first[0]), "600미터 앞 과속 단속, 제한 속도 50");
  assert.equal(watch.due(300).length, 0); // still between rungs
  const second = watch.due(520); // 280 m
  assert.equal(second[0].rungM, 300);
  assert.equal(watch.due(700).length, 0); // both said
});

/** Straight for [runM], then an arc of [deg] drawn as five 8 m steps, from [from] heading [bearing]. */
function arcPath(from: LonLat, bearing: number, runM: number, deg: number): { path: LonLat[]; heading: number } {
  const path: LonLat[] = [];
  let at = from;
  for (let d = 0; d < runM; d += 20) { at = offset(at, bearing, 20); path.push(at); }
  let h = bearing;
  for (let k = 0; k < 5; k++) { h += deg / 5; at = offset(at, h, 8); path.push(at); }
  return { path, heading: h };
}

test("the right-angle corner is a guide, not a bend; a bend drawn as an arc elsewhere is found", () => {
  assert.equal(findCurves(route).length, 0);
  const one = arcPath(start, 0, 200, 60);
  const tail = arcPath(one.path[one.path.length - 1], one.heading, 200, 0);
  const bendy: Route = { ...route, path: [start, ...one.path, ...tail.path], guides: [] };
  const curves = findCurves(bendy);
  assert.equal(curves.length, 1);
  assert.equal(curves[0].kind, "curve");
});

test("a road that jogs at one vertex (a junction) is not a bend", () => {
  const a = Array.from({ length: 11 }, (_, i) => offset(start, 0, i * 20));
  const b = Array.from({ length: 10 }, (_, i) => offset(a[10], 60, (i + 1) * 20));
  assert.equal(findCurves({ ...route, path: [...a, ...b], guides: [] }).length, 0);
});

test("a winding stretch is one 연속 급커브, said once; a bend far on is its own", () => {
  let at = start, h = 0;
  const path: LonLat[] = [start];
  // Three bends 250 m apart, then 1.5 km straight, then one more.
  for (const [run, deg] of [[200, 50], [250, -50], [250, 50], [1500, -50], [200, 0]] as const) {
    const leg = arcPath(at, h, run, deg);
    path.push(...leg.path);
    at = leg.path[leg.path.length - 1];
    h = leg.heading;
  }
  const curves = findCurves({ ...route, path, guides: [] });
  assert.deepEqual(curves.map((c) => c.kind), ["curves", "curve"]);
  const watch = new RouteWatch({ ...route, path, guides: [] });
  assert.equal(phraseFor({ ...watch.ahead(0, 400)[0], rungM: 200 }), "200미터 앞 연속 급커브 구간입니다");
});

function lonLat([lon, lat]: LonLat) {
  return { lon, lat };
}

test("an accident hotspot whose circle the route passes through is on the route", () => {
  const watch = new RouteWatch(route);
  // Centre 90 m beside the road, circle 120 m wide: the road runs through it. Another 90 m off with a 50 m circle: not.
  watch.add([
    { id: "spot", kind: "accident", ...lonLat(offset(offset(start, 0, 600), 90, 90)), radiusM: 120 },
    { id: "far", kind: "accident", ...lonLat(offset(offset(start, 0, 700), 90, 90)), radiusM: 50 },
  ]);
  assert.deepEqual(watch.ahead(100).map((a) => a.feature.id), ["spot"]);
  const due = watch.due(320);
  assert.equal(phraseFor(due[0]), "300미터 앞 사고 다발 지역입니다");
});

test("a camera said before a re-route is not said again on the new route to the same place", () => {
  const spoken = new Map<string, Set<number>>();
  const cam: Feature = { id: "cam", kind: "speed", ...lonLat(offset(start, 0, 800)), limit: 50 };
  const first = new RouteWatch(route, undefined, spoken);
  first.add([cam]);
  assert.equal(first.due(250).length, 1); // 600 m rung said
  const again = new RouteWatch(route, undefined, spoken);
  again.add([cam]);
  assert.equal(again.due(260).length, 0);
  assert.equal(again.due(520)[0].rungM, 300); // the next rung still comes
});
