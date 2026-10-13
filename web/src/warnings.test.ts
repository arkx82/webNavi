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

test("a stretch's start camera passed the other way (its end behind, 동부간선 southbound 2026-10-04) opens no stretch", () => {
  const watch = new RouteWatch(route);
  // The route goes north then east. The other way's start at 900 m, its end back at the route's start, 1 km south.
  const end = offset(start, 180, 200);
  watch.add([{ id: "theirs", kind: "section-start", ...lonLat(offset(start, 0, 900)), limit: 80, direction: "1", pair: end }]);
  assert.deepEqual(watch.sections(), []);
  assert.deepEqual(watch.ahead(0, 2100).map((a) => a.feature.id), []);
  assert.equal(watch.limitAt(1500), null);
});

test("a stretch the route takes runs from its start to where the route leaves for good, not 25 km on", () => {
  const watch = new RouteWatch(route);
  // Start at 200 m going north, its end 3 km further north; the route turns east at 1 km.
  const end = offset(start, 0, 4000);
  watch.add([{ id: "ours", kind: "section-start", ...lonLat(offset(start, 0, 200)), limit: 60, direction: "2", pair: end }]);
  const [s] = watch.sections();
  assert.equal(s.feature.id, "ours");
  assert.ok(Math.abs(s.endM - 1000) < 30, `${s.endM}`);
  assert.equal(watch.limitAt(1500), null);
});

test("an end camera the route comes to from the far side is the other way's, and unsaid", () => {
  const watch = new RouteWatch(route);
  // An end at 500 m whose start is 2 km further north: going north the car meets the end before the start.
  watch.add([{ id: "end", kind: "section-end", ...lonLat(offset(start, 0, 500)), direction: "1", pair: offset(start, 0, 2500) }]);
  assert.deepEqual(watch.ahead(0, 2100).map((a) => a.feature.id), []);
});

test("the other way's camera (its carriageway against the route) is not the route's; one at a crossing is", () => {
  const watch = new RouteWatch(route);
  // The route runs north here.
  const at = (m: number, side: number) => offset(offset(start, 0, m), 90, side);
  watch.add([
    // The other way's, on the far carriageway (강변북로 westbound by the ramp east, 2026-10-04).
    { id: "other-way", kind: "speed", ...lonLat(at(500, 12)), limit: 80, ways: [{ deg: 180, at: at(500, 12) }] },
    // Our way, but a road beside the route, 20 m off.
    { id: "beside", kind: "speed", ...lonLat(at(600, 19)), limit: 80, ways: [{ deg: 0, at: at(600, 20) }] },
    // Ours, on a two-way street, and one at a crossing with the cross street the nearer.
    { id: "ours", kind: "speed", ...lonLat(at(700, 6)), limit: 80, ways: [{ deg: 0, at: at(700, 3) }, { deg: 180, at: at(700, 3) }] },
    { id: "crossing", kind: "signal", ...lonLat(at(800, 8)), ways: [{ deg: 90, at: at(800, 9) }, { deg: 0, at: at(800, 4) }] },
    // Not put on a road (the server could not ask): as before.
    { id: "unknown", kind: "speed", ...lonLat(at(900, 10)), limit: 80 },
  ]);
  // "beside" runs our way, 20 m off: a carriageway of ours drawn apart, or a road beside — kept, as before.
  assert.deepEqual(watch.ahead(0).map((a) => a.feature.id), ["beside", "ours", "crossing", "unknown"]);
});

test("a school zone whose school is on a side street is not the route's, unless a camera of the zone stands on the route", () => {
  const watch = new RouteWatch(route);
  const at = (m: number, side: number) => offset(offset(start, 0, m), 90, side);
  watch.add([
    // 36 m off the route, its gate on a lane 50 m off (양재대로's 예지어린이집).
    { id: "side", kind: "school-zone", ...lonLat(at(400, 36)), ways: [{ deg: -1, at: at(400, 50) }] },
    // The same, but a school camera of the zone on the route by it: the zone is the route's.
    { id: "cam-zone", kind: "school-zone", ...lonLat(at(800, 40)), ways: [{ deg: -1, at: at(800, 55) }] },
    { id: "cam", kind: "speed", ...lonLat(at(820, 6)), limit: 30, zone: "school" },
    // Its street the route itself.
    { id: "on", kind: "school-zone", ...lonLat(offset(corner, 90, 500)), ways: [{ deg: -1, at: offset(corner, 90, 500) }] },
  ]);
  const ids = watch.ahead(0, 2100).map((a) => a.feature.id);
  assert.ok(!ids.includes("side"), ids.join(","));
  assert.ok(ids.includes("cam-zone") && ids.includes("on"), ids.join(","));
  assert.notEqual(watch.limitAt(400)?.why, "school", "no school limit by the side street's zone (the camera ahead may give one)");
  assert.deepEqual(watch.limitAt(800), { limit: 30, why: "school" });
});

test("a school by a wide road (3 lanes one way and more) is the road's zone only with a camera of it on the route", () => {
  const watch = new RouteWatch(route);
  const at = (m: number, side: number) => offset(offset(start, 0, m), 90, side);
  watch.add([
    { id: "wide", kind: "school-zone", ...lonLat(at(300, 36)), ways: [{ deg: -1, at: at(300, 8), lanes: 5 }] },
    { id: "narrow", kind: "school-zone", ...lonLat(at(700, 30)), ways: [{ deg: -1, at: at(700, 3), lanes: 1 }] },
    // Two lanes here (a side road over an underpass) but a 대로.
    { id: "daero", kind: "school-zone", ...lonLat(at(900, 30)), ways: [{ deg: -1, at: at(900, 3), lanes: 2, name: "양재대로" }] },
    { id: "unknown", kind: "school-zone", ...lonLat(offset(corner, 90, 400)), ways: [{ deg: -1, at: offset(corner, 90, 400), lanes: null }] },
  ]);
  assert.deepEqual(watch.ahead(0, 2100).filter((a) => a.feature.kind === "school-zone").map((a) => a.feature.id), ["narrow", "unknown"]);
  watch.add([{ id: "cam", kind: "speed", ...lonLat(at(330, 6)), limit: 50, zone: "school" }]);
  assert.deepEqual(watch.ahead(0, 2100).filter((a) => a.feature.kind === "school-zone").map((a) => a.feature.id), ["wide", "narrow", "unknown"]);
});

test("a stretch's start the route passes going across, never nearer its end (영동고속도로 westbound, 2026-10-05), opens no stretch", () => {
  const watch = new RouteWatch(route);
  // The route north then east; a start at 1500 m (on the east leg), its end 4 km away to the south-west, which the
  // route only goes further from — though at the start it runs across, not away.
  const atStart = offset(corner, 90, 500);
  watch.add([{ id: "theirs", kind: "section-start", ...lonLat(atStart), limit: 80, direction: "1", pair: offset(atStart, 180, 4000) }]);
  assert.deepEqual(watch.sections(), []);
  assert.equal(watch.limitAt(1700), null);
});

/** [m] metres along the route's northbound leg, [side] metres east of it. */
const north_ = (m: number, side = 0) => offset(offset(start, 0, m), 90, side);

test("a camera at a junction put on the other carriageway and a side road is the other way's; one on a side road alone, or on both ways, is kept", () => {
  const watch = new RouteWatch(route);
  watch.add([
    // 운천제2교차로's northbound camera met going south (2026-10-11): 호국로 the other way, and a side road.
    { id: "junction-theirs", kind: "speed", ...lonLat(north_(300, 8)), limit: 70, ways: [{ deg: 180, at: north_(300, 8) }, { deg: 90, at: north_(300, 4) }] },
    // The side road alone (a road across, 45–135° off the route): says nothing either way.
    { id: "side-only", kind: "speed", ...lonLat(north_(500, 8)), limit: 70, ways: [{ deg: 90, at: north_(500, 6) }] },
    { id: "both-ways", kind: "speed", ...lonLat(north_(700, 4)), limit: 70, ways: [{ deg: 0, at: north_(700, 2) }, { deg: 180, at: north_(700, 6) }] },
  ]);
  assert.deepEqual(watch.ahead(0).map((a) => a.feature.id), ["side-only", "both-ways"]);
});

test("two rows of one camera give one limit whichever comes first: the row on our carriageway's, else the lower", () => {
  const rows = (a: Feature, b: Feature) => {
    const watch = new RouteWatch(route);
    watch.add([a, b]);
    return watch.ahead(0).map((x) => `${x.feature.kind} ${x.feature.limit}`);
  };
  const eighty: Feature = { id: "80", kind: "speed", ...lonLat(north_(600, 3)), limit: 80 };
  const seventy: Feature = { id: "70", kind: "speed", ...lonLat(north_(603, 3)), limit: 70 };
  assert.deepEqual(rows(eighty, seventy), ["speed 70"]);
  assert.deepEqual(rows(seventy, eighty), ["speed 70"]);
  // The 80 stands on our carriageway, the 70 only on the cross street: the 80 is ours.
  const ours = { ...eighty, ways: [{ deg: 0, at: north_(600, 2) }] };
  const across = { ...seventy, ways: [{ deg: 90, at: north_(603, 5) }] };
  assert.deepEqual(rows(ours, across), ["speed 80"]);
  assert.deepEqual(rows(across, ours), ["speed 80"]);
  // A signal row's limit gives way to a speed row's.
  assert.deepEqual(rows({ ...seventy, kind: "signal", limit: 60 }, eighty), ["speed-signal 80"]);
});

test("two speed cameras 77 m apart with two limits are one warning at the first, with the lower (민락, 2026-10-11)", () => {
  const watch = new RouteWatch(route);
  watch.add([
    { id: "sixty", kind: "speed", ...lonLat(north_(500, 3)), limit: 60 },
    { id: "fifty", kind: "speed", ...lonLat(north_(577, 3)), limit: 50 },
    // The same limit 100 m on: its own warning, as before.
    { id: "fifty-again", kind: "speed", ...lonLat(north_(677, 3)), limit: 50 },
  ]);
  const ahead = watch.ahead(0);
  assert.deepEqual(ahead.map((a) => [a.feature.limit, Math.round(a.alongM)]), [[50, 500], [50, 677]]);
  const due = watch.due(0);
  assert.deepEqual(due.map((d) => phraseFor(d)), ["육백미터 앞에 과속 단속 카메라가 있습니다, 제한 속도 오십입니다"]);
  assert.equal(watch.limitAt(0)?.limit, 50);
});

test("a camera its site puts 400 m before the junction is not merged with the junction's signal camera at its point (양문사거리)", () => {
  const watch = new RouteWatch(route);
  watch.add([
    { id: "F6124", kind: "signal", ...lonLat(north_(800, 3)), limit: 80 },
    { id: "F6204", kind: "speed", ...lonLat(north_(800, 3)), limit: 80, beforeM: 400 },
  ]);
  assert.deepEqual(watch.ahead(0).map((a) => a.feature.kind).sort(), ["signal", "speed"]);
});

test("a 구간 단속 start with its pair is judged by its pair, not by the carriageway its point is on; it ends where the route leaves the motorway", () => {
  // The route north on a motorway for its first 700 m (vertices 0–14), then off it and on, then east.
  const motorway: Route = { ...route, motorways: [[0, 14]] };
  const southStart: Feature = { id: "start", kind: "section-start", ...lonLat(north_(300, 30)), limit: 80, direction: "1",
    // Its point on the other carriageway's line (동부간선's 상계 start, J8831), its end 3 km on the way we go.
    ways: [{ deg: 180, at: north_(300, 30) }], pair: north_(3300, 0) };
  const watch = new RouteWatch(motorway);
  watch.add([southStart]);
  const [s] = watch.sections();
  assert.equal(s?.feature.id, "start");
  assert.ok(Math.abs(s.alongM - 300) < 5 && Math.abs(s.endM - 700) < 5, `${s.alongM}–${s.endM}`);
  assert.deepEqual(watch.limitAt(500), { limit: 80, why: "section" });
  assert.notEqual(watch.limitAt(800)?.why, "section");
  // Its end behind the car (the route the other way along the road): no stretch, said or shown.
  const behind = new RouteWatch(motorway);
  behind.add([{ ...southStart, pair: offset(start, 180, 2700) }]);
  assert.deepEqual(behind.sections(), []);
  assert.deepEqual(behind.ahead(0, 2100).map((a) => a.feature.id), []);
});

test("off the motorways a stretch ends where the route leaves the line from its start to its end", () => {
  // Start at 100 m, its end 5 km on to the north-north-east: the route bends away at the corner (1 km) to the east,
  // still nearing the end for a while.
  const watch = new RouteWatch(route);
  watch.add([{ id: "start", kind: "section-start", ...lonLat(north_(100, 3)), limit: 60, direction: "1", pair: offset(north_(100), 15, 5000) }]);
  const [s] = watch.sections();
  // 0.1 × 5 km = 500 m off the line: some 500–700 m along the east leg, not the 2 km the route goes on nearing it.
  assert.ok(s && s.endM > 1300 && s.endM < 1800, `${s?.endM}`);
});

test("a camera the list puts far off its road is where the server put it on its road, if that runs our way (G5870, 143 m off)", () => {
  const watch = new RouteWatch(route);
  watch.add([
    { id: "ours", kind: "speed", ...lonLat(north_(500, 143)), limit: 100, ways: [{ deg: 0, at: north_(500, 2) }] },
    { id: "theirs", kind: "speed", ...lonLat(north_(800, 143)), limit: 100, ways: [{ deg: 180, at: north_(800, 2) }] },
    { id: "nowhere", kind: "speed", ...lonLat(north_(900, 143)), limit: 100 },
  ]);
  const ahead = watch.ahead(0);
  assert.deepEqual(ahead.map((a) => a.feature.id), ["ours"]);
  assert.ok(Math.abs(ahead[0].alongM - 500) < 3);
});

test("a 보호구역 on a wide road is the road's with a camera of it on the other carriageway, and takes its limit (영중초, 2026-10-11)", () => {
  const watch = new RouteWatch(route);
  watch.add([
    { id: "zone", kind: "school-zone", ...lonLat(north_(300, 36)), ways: [{ deg: -1, at: north_(300, 8), lanes: 3 }] },
    // Its camera faces the other way (신북->철원): left out as a camera, but the zone is the road's both ways.
    { id: "cam", kind: "speed", ...lonLat(north_(320, 9)), limit: 50, zone: "school", ways: [{ deg: 180, at: north_(320, 9) }] },
  ]);
  const ids = watch.ahead(0, 2100).map((a) => a.feature.id);
  assert.deepEqual(ids, ["zone"]);
  assert.deepEqual(watch.limitAt(300), { limit: 50, why: "school" });
});

/** A speed bump [sideM] east of the north leg [m] along, on a lane of the HD map running [deg] (−1: not known). */
function bumpOnLane(id: string, m: number, sideM: number, deg: number): Feature {
  const at = offset(offset(start, 0, m), 90, sideM);
  return { id, kind: "bump", ...lonLat(at), lane: { deg, at } };
}

test("a bump on a lane of the HD map is the route's only on the route's lane: not on a road beside it, nor across it", () => {
  const watch = new RouteWatch(route);
  watch.add([
    bumpOnLane("own-lane", 300, 2, 0),
    // A two-way road's bump on the other way's lane is still the road's.
    bumpOnLane("other-way-lane", 400, -3.5, 180),
    bumpOnLane("lane-unknown", 450, 1, -1),
    // 포천's side lane (5.6 m, the route's way) and 철원's frontage road (12 m): passed at 80–90 km/h, 2026-10-11.
    bumpOnLane("side-lane", 500, 5.6, 0),
    bumpOnLane("frontage", 600, 12, 2),
    // On a road across, 3 m in from the route (the slip road 9.7 m off at 43°, 2026-10-11).
    bumpOnLane("across", 700, 3, 60),
  ]);
  assert.deepEqual(watch.ahead(0, 2000).map((a) => a.feature.id), ["own-lane", "other-way-lane", "lane-unknown"]);
});

test("a public bump the HD map has no lane for is placed as before, 20 m off; one put on a lane is judged by it", () => {
  const watch = new RouteWatch(route);
  const rough = offset(offset(start, 0, 300), 90, 20);
  const pub = offset(offset(start, 0, 500), 90, 4);
  watch.add([
    { id: "town-road", kind: "bump", ...lonLat(rough) },
    // Its own point 4 m off; the lane it is on (the server's snap) the other carriageway's, 11 m off.
    { id: "snapped-away", kind: "bump", ...lonLat(pub), lane: { deg: 180, at: offset(offset(start, 0, 500), 90, 11) } },
  ]);
  assert.deepEqual(watch.ahead(0, 2000).map((a) => a.feature.id), ["town-road"]);
});

test("no bump in an underpass: from the guide that enters it to the next guide, UNDERPASS_M at most", () => {
  const under: Route = {
    ...route,
    guides: [
      { at: offset(start, 0, 200), text: "만가대교차로에서 '동두천, 양주, 포천' 방면으로 왼쪽 지하차도 진입", distanceM: 200, turnType: 64 },
      { at: corner, text: "우회전", distanceM: 1000, turnType: 2 },
    ],
  };
  const watch = new RouteWatch(under);
  watch.add([
    bumpOnLane("before", 150, 1, 0),
    // NAVER's line on the frontage road over the underpass: the bumps 1–3 m off it (2026-10-11).
    bumpOnLane("above", 500, 1.5, 0),
    { id: "above-public", kind: "bump", ...lonLat(offset(offset(start, 0, 800), 90, 15)) },
    // Past the next guide the underpass is over.
    { id: "after", kind: "bump", ...lonLat(offset(corner, 90, 300)), lane: { deg: 90, at: offset(corner, 90, 300) } },
  ]);
  assert.deepEqual(watch.ahead(0, 2000).map((a) => a.feature.id), ["before", "after"]);
  // A road beside one ("지하차도 옆길") is not in it.
  const beside = new RouteWatch({ ...under, guides: [{ ...under.guides[0], text: "지하차도 옆길로 진입" }, under.guides[1]] });
  beside.add([bumpOnLane("above", 500, 1.5, 0)]);
  assert.deepEqual(beside.ahead(0, 2000).map((a) => a.feature.id), ["above"]);
});

test("the sign: the road's limit along the route, a speed camera's own over it round the camera, a school zone's over all", () => {
  const watch = new RouteWatch(route);
  // The server's runs: path positions (vertex 10 is 500 m along, vertex 30 is 1500 m).
  watch.setRoadLimits([{ from: 0, to: 10, kmh: 60, src: "tmap" }, { from: 10, to: 39, kmh: 50, src: "tmap" }]);
  assert.deepEqual(watch.signLimitAt(200), { kmh: 60, why: "road", src: "tmap" });
  assert.equal(watch.signLimitAt(800)?.kmh, 50);
  // A speed camera at 1700 m saying 40 where the list has 50: 40 from 700 m before it to 300 m past, the 50 kept beyond.
  watch.add([{ id: "cam40", kind: "speed", ...lonLat(offset(corner, 90, 700)), limit: 40 }]);
  assert.deepEqual(watch.signLimitAt(1500), { kmh: 40, why: "road", src: "camera" });
  assert.equal(watch.signLimitAt(600)?.kmh, 50, "more than 1 km before the camera is the list's again");
  // A school zone's camera is the zone's, not the road's.
  watch.add([{ id: "zone", kind: "school-zone", ...lonLat(offset(start, 0, 300)), limit: 30 }]);
  assert.deepEqual(watch.signLimitAt(300), { kmh: 30, why: "zone", src: "zone" });
  // Past the line's end: nothing.
  assert.equal(watch.signLimitAt(5000), null);
});
