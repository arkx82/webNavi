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
  assert.equal(phraseFor(first[0]), "육백미터 앞에 과속 단속 카메라가 있습니다, 제한 속도 오십입니다");
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
  assert.equal(phraseFor({ ...watch.ahead(0, 400)[0], rungM: 200 }), "이백미터 앞에 연속 급커브 구간이 있습니다");
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
  assert.equal(phraseFor(due[0]), "삼백미터 앞에 사고 다발 지역이 있습니다");
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

test("a school zone is a strip of the route beside the school: warned before it, held at 30 inside", () => {
  const watch = new RouteWatch(route);
  // The school 60 m beside the road at 700 m along: the zone runs 550–850 m. Another 160 m off is on another street.
  watch.add([
    { id: "zone", kind: "school-zone", ...lonLat(offset(offset(start, 0, 700), 90, 60)), limit: 30 },
    { id: "far", kind: "school-zone", ...lonLat(offset(offset(start, 0, 300), 90, 160)), limit: 30 },
  ]);
  assert.deepEqual(watch.ahead(0).map((a) => a.feature.id), ["zone"]);
  const [due] = watch.due(260);
  assert.equal(phraseFor(due), "삼백미터 앞부터 어린이 보호구역입니다, 제한 속도 삼십입니다");
  assert.equal(watch.limitAt(500), null);
  assert.deepEqual(watch.limitAt(600), { limit: 30, why: "school" });
  assert.equal(watch.limitAt(900), null);
});

test("on a motorway no school zone or speed bump is on the route, whatever is beside it", () => {
  // The first 1 km (vertices 0–20) is a motorway; the turn east is a town street.
  const watch = new RouteWatch({ ...route, motorways: [[0, 20]] });
  watch.add([
    { id: "zone-by-motorway", kind: "school-zone", ...lonLat(offset(offset(start, 0, 500), 90, 40)), limit: 30 },
    { id: "bump-on-frontage", kind: "bump", ...lonLat(offset(offset(start, 0, 600), 90, 15)) },
    { id: "cam", kind: "speed", ...lonLat(offset(start, 0, 700)), limit: 80 },
    { id: "zone-in-town", kind: "school-zone", ...lonLat(offset(offset(corner, 90, 500), 0, 50)), limit: 30 },
  ]);
  assert.deepEqual(watch.ahead(0, 2000).map((a) => a.feature.id), ["cam", "zone-in-town"]);
});

test("a rest area on the right is ours; one on the left is the other carriageway's", () => {
  const watch = new RouteWatch(route);
  watch.add([
    { id: "ours", kind: "rest-area", ...lonLat(offset(offset(start, 0, 500), 90, 120)) },
    { id: "theirs", kind: "rest-area", ...lonLat(offset(offset(start, 0, 600), 270, 120)) },
  ]);
  assert.deepEqual(watch.ahead(0, 2000).map((a) => a.feature.id), ["ours"]);
});

test("an incident list asked again replaces the last one", () => {
  const watch = new RouteWatch(route);
  watch.add([{ id: "old", kind: "incident-work", ...lonLat(offset(start, 0, 700)) }]);
  watch.drop(["incident-crash", "incident-work", "incident-other"]);
  watch.add([{ id: "new", kind: "incident-crash", ...lonLat(offset(start, 0, 800)) }]);
  assert.deepEqual(watch.ahead(0).map((a) => a.feature.id), ["new"]);
  assert.equal(phraseFor(watch.due(0)[0]), "일킬로미터 앞에 교통사고가 났습니다, 주의하세요");
});

test("a camera's sentence ends as a sentence: its limit, or what it is", () => {
  const say = (kind: Feature["kind"], limit?: number) => phraseFor({ feature: { id: "x", kind, lon: 0, lat: 0, limit }, alongM: 0, inM: 0, rungM: 300 });
  assert.equal(say("speed", 80), "삼백미터 앞에 과속 단속 카메라가 있습니다, 제한 속도 팔십입니다");
  assert.equal(say("speed"), "삼백미터 앞에 과속 단속 카메라가 있습니다");
  assert.equal(say("section-start", 100), "삼백미터 앞에서 구간 단속이 시작됩니다, 제한 속도 백입니다");
  assert.equal(say("section-start"), "삼백미터 앞에서 구간 단속이 시작됩니다");
  assert.equal(say("school", 30), "삼백미터 앞부터 어린이 보호구역입니다, 제한 속도 삼십입니다");
});

test("a traffic light warns only while it flashes, and a pass by day leaves the night's warning", async () => {
  const { flashingNow } = await import("./warnings");
  const at = (hhmm: string) => Date.parse(`2026-09-30T${hhmm}:00+09:00`);
  assert.ok(flashingNow({ flash: "00:00-05:00" }, at("02:30")));
  assert.ok(!flashingNow({ flash: "00:00-05:00" }, at("05:00")));
  assert.ok(flashingNow({ flash: "22:00-05:00" }, at("23:10")));
  assert.ok(flashingNow({ flash: "22:00-05:00" }, at("04:59")));
  assert.ok(!flashingNow({ flash: "22:00-05:00" }, at("12:00")));
  assert.ok(flashingNow({ flash: "always" }, at("12:00")));
  assert.ok(!flashingNow({}, at("02:00")));
  const watch = new RouteWatch(route);
  watch.add([{ id: "light", kind: "signal-light", ...lonLat(offset(start, 0, 500)), flash: "always" }, { id: "day", kind: "signal-light", ...lonLat(offset(start, 0, 600)) }]);
  const said = watch.due(320).map((d) => phraseFor(d));
  assert.deepEqual(said, ["잠시 후 점멸 신호 교차로입니다, 서행하세요"]);
});

test("a camera first learned of at 250 m gets its 300 m rung alone, not the 600 m one and then the 300 m one", () => {
  const watch = new RouteWatch(route);
  // The server's answer came late: the camera 800 m along is added with the car already at 550 m.
  watch.add([{ id: "late", kind: "speed", ...lonLat(offset(start, 0, 800)), limit: 50 }]);
  const first = watch.due(550);
  assert.equal(first.length, 1);
  assert.equal(first[0].rungM, 300);
  assert.equal(watch.due(560).length, 0);
  assert.equal(watch.due(700).length, 0);
});

test("a 신호·과속 camera given as two rows is one warning", () => {
  const watch = new RouteWatch(route);
  watch.add([
    { id: "sig", kind: "signal", ...lonLat(offset(start, 0, 800)) },
    { id: "spd", kind: "speed", ...lonLat(offset(start, 0, 815)), limit: 50 },
    // 100 m on: another camera, its own warning.
    { id: "next", kind: "signal", ...lonLat(offset(start, 0, 900)) },
  ]);
  const due = watch.due(250);
  assert.deepEqual(due.map((d) => d.feature.id), ["sig"]);
  assert.equal(phraseFor(due[0]), "육백미터 앞에 신호 과속 단속 카메라가 있습니다, 제한 속도 오십입니다");
  assert.equal(watch.ahead(250).length, 2);
});

test("a school zone by the road onto a motorway stops where the motorway begins", () => {
  // The motorway from vertex 10: 500 m on.
  const watch = new RouteWatch({ ...route, motorways: [[10, 40]] });
  watch.add([{ id: "kids", kind: "school-zone", ...lonLat(offset(offset(start, 0, 450), 90, 30)), limit: 30 }]);
  const [zone] = watch.zones();
  assert.ok(Math.abs(zone.alongM - 300) < 2);
  assert.ok(Math.abs(zone.endM - 500) < 2);
});

test("the sentences ahead are every rung of every warning said within the horizon, none of those only shown", () => {
  const watch = new RouteWatch(route, () => ({ wants: (k) => k !== "bump", cameraFromM: 600 }));
  watch.add([
    { id: "cam", kind: "speed", ...lonLat(offset(start, 0, 800)), limit: 50 },
    { id: "bump", kind: "bump", ...lonLat(offset(start, 0, 600)) },
    { id: "far", kind: "speed", ...lonLat(offset(corner, 90, 900)), limit: 60 },
  ]);
  const near = watch.phrasesAhead(100, 1500);
  assert.deepEqual(near, ["육백미터 앞에 과속 단속 카메라가 있습니다, 제한 속도 오십입니다", "삼백미터 앞에 과속 단속 카메라가 있습니다, 제한 속도 오십입니다"]);
  // Further on, the next camera comes in.
  assert.equal(watch.phrasesAhead(100, 2000).length, 4);
  // Fetching ahead says nothing: the camera's rungs are all still to come.
  assert.equal(watch.due(250).length, 1);
});

test("a school zone's limit is the one its camera on the route says — 50 on a wide road — and none is guessed", () => {
  const watch = new RouteWatch(route);
  watch.add([
    // At 700 m, the server knowing no limit for it (cameras round it disagree), a 50 camera of the zone on the route.
    { id: "wide", kind: "school-zone", ...lonLat(offset(offset(start, 0, 700), 90, 60)) },
    { id: "cam", kind: "speed", ...lonLat(offset(start, 0, 760)), limit: 50, zone: "school" },
    // On the east leg, no camera and no limit known.
    { id: "quiet", kind: "school-zone", ...lonLat(offset(offset(corner, 90, 600), 0, 60)) },
  ]);
  const [due] = watch.due(260).filter((d) => d.feature.id === "wide");
  assert.equal(phraseFor(due), "삼백미터 앞부터 어린이 보호구역입니다, 제한 속도 오십입니다");
  assert.deepEqual(watch.limitAt(600), { limit: 50, why: "school" });
  const [quiet] = watch.due(1000 + 600 - 150 - 200).filter((d) => d.feature.id === "quiet");
  assert.equal(phraseFor(quiet), "삼백미터 앞부터 어린이 보호구역입니다");
  assert.equal(watch.limitAt(1600), null, "no 30 guessed");
});

test("a two-way 구간 단속: this carriageway's start to its end; the other's cameras (its end by our start, its start by our end) unsaid", () => {
  const watch = new RouteWatch(route);
  const at = (m: number) => lonLat(m <= 1000 ? offset(start, 0, m) : offset(corner, 90, m - 1000));
  watch.add([
    { id: "ours-start", kind: "section-start", ...at(100), limit: 60, direction: "1" },
    { id: "theirs-end", kind: "section-end", ...at(115), direction: "2" },
    { id: "theirs-start", kind: "section-start", ...at(1785), limit: 60, direction: "02" },
    { id: "ours-end", kind: "section-end", ...at(1800), direction: "01" },
  ]);
  assert.deepEqual(watch.sections().map((s) => [s.feature.id, Math.round(s.alongM), Math.round(s.endM)]), [["ours-start", 100, 1800]]);
  assert.deepEqual(watch.ahead(0, 2100).map((a) => a.feature.id), ["ours-start", "ours-end"]);
  assert.deepEqual(watch.limitAt(1000), { limit: 60, why: "section" });
  assert.equal(watch.limitAt(1900), null);
});

test("two 구간 단속 one after another the same way are both kept", () => {
  const watch = new RouteWatch(route);
  const at = (m: number) => lonLat(m <= 1000 ? offset(start, 0, m) : offset(corner, 90, m - 1000));
  watch.add([
    { id: "a", kind: "section-start", ...at(100), limit: 80, direction: "1" },
    { id: "b", kind: "section-end", ...at(700), direction: "1" },
    { id: "c", kind: "section-start", ...at(1200), limit: 100, direction: "1" },
  ]);
  assert.deepEqual(watch.sections().map((s) => s.feature.id), ["a", "c"]);
  assert.deepEqual(watch.ahead(0, 2100).map((a) => a.feature.id), ["a", "b", "c"]);
});
