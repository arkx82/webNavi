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
  assert.equal(phraseFor(first[0]), "600미터 앞 과속 단속, 제한 50");
  assert.equal(watch.due(300).length, 0); // still between rungs
  const second = watch.due(520); // 280 m
  assert.equal(second[0].rungM, 300);
  assert.equal(watch.due(700).length, 0); // both said
});

test("the right-angle corner is a guide, not a bend; a bend elsewhere is found", () => {
  assert.equal(findCurves(route).length, 0);
  // A road that swings 60° over 40 m half-way along, with no guide there.
  const a = Array.from({ length: 11 }, (_, i) => offset(start, 0, i * 20));
  const b = Array.from({ length: 10 }, (_, i) => offset(a[10], 60, (i + 1) * 20));
  const bendy: Route = { ...route, path: [...a, ...b], guides: [] };
  const curves = findCurves(bendy);
  assert.equal(curves.length, 1);
  assert.equal(curves[0].kind, "curve");
});

function lonLat([lon, lat]: LonLat) {
  return { lon, lat };
}
