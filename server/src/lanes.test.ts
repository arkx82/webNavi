import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AFTER_POINTS, LaneIndex, lanesAlong, surveyYear, turnOf } from "./lanes.js";
import type { LonLat } from "./route/types.js";

test("the survey's year is read by the ID's prefix: A2 + YY, NT + layer digit + YY; none without an ID", () => {
  assert.equal(surveyYear("A219A0000001"), 19);
  assert.equal(surveyYear("A217BR720001"), 17);
  assert.equal(surveyYear("A223AI012001"), 23);
  assert.equal(surveyYear("NT2259F410001"), 25, "not the layer digit and the year's first digit (22)");
  assert.equal(surveyYear("NT2264F410001"), 26);
  assert.equal(surveyYear("NT223AI012001"), 23);
  assert.equal(surveyYear(null), 0);
  assert.equal(surveyYear(undefined), 0);
  assert.equal(surveyYear(""), 0);
  assert.equal(surveyYear("XYZ"), 0);
  assert.equal(surveyYear("A2"), 0);
});

test("a turn from the headings in and out", () => {
  assert.equal(turnOf(0, 0), "straight");
  assert.equal(turnOf(0, 270), "left");
  assert.equal(turnOf(0, 90), "right");
  assert.equal(turnOf(0, 180), "uturn");
});

// A junction laid out in metres about a point in Seoul, put into lon/lat.
const O: LonLat = [127.0, 37.5];
const M = 111_320;
const at = (x: number, y: number): LonLat => [O[0] + x / (M * Math.cos((O[1] * Math.PI) / 180)), O[1] + y / M];
const link = (p: Record<string, string | number | null>, pts: [number, number][]) =>
  JSON.stringify({ type: "Feature", properties: p, geometry: { type: "LineString", coordinates: pts.map(([x, y]) => at(x, y)) } });

async function indexOf(lines: string[]): Promise<LaneIndex> {
  const dir = mkdtempSync(join(tmpdir(), "lanes-"));
  writeFileSync(join(dir, "links.geojsons"), lines.join("\n") + "\n");
  const index = new LaneIndex(join(dir, "links.geojsons"), join(dir, "lanes.db"));
  await index.refresh();
  assert.ok(index.ready);
  return index;
}

test("two lanes at a stop line, the left one left-only: the right one is the route's, straight on; a link without an ID does not throw", async () => {
  const index = await indexOf([
    // The lanes coming north to the stop line at y = 0, each knowing its neighbour.
    link({ id: "A219A000001", lane: 1, a: "N0", b: "N1", l: null, r: "A219A000002" }, [[-1.75, -100], [-1.75, -50], [-1.75, 0]]),
    link({ id: "A219A000002", lane: 2, a: "N0", b: "N2", l: "A219A000001", r: null }, [[1.75, -100], [1.75, -50], [1.75, 0]]),
    // An older survey's lane of the same road (2017): left out for the newer.
    link({ id: "A217A000009", lane: 1, a: "X0", b: "X1", l: null, r: null }, [[-5.25, -100], [-5.25, -50], [-5.25, 0]]),
    // One with no ID at all (the column is nullable).
    link({ id: null, lane: 3, a: "Y0", b: "Y1", l: null, r: null }, [[5.25, -100], [5.25, -50], [5.25, 0]]),
    // Through the junction: the left lane turns left, the right goes straight.
    link({ id: "A219A000011", lane: 1, a: "N1", b: null, l: null, r: null }, [[-1.75, 0], [-10, 15], [-40, 25], [-80, 27]]),
    link({ id: "A219A000012", lane: 1, a: "N2", b: null, l: null, r: null }, [[1.75, 0], [1.75, 60], [1.75, 160]]),
  ]);
  const after: LonLat[] = [];
  for (let y = -100; y <= 160; y += 15) after.push(at(0, y));
  const info = index.lanes(at(0, 0), 0, after, null);
  assert.ok(info, "lanes found");
  assert.deepEqual(info.lanes, [{ turns: ["left"], best: false }, { turns: ["straight"], best: true }]);
  assert.ok(Math.abs(info.stopM) <= 1, `the stop line at the guide, ${info.stopM} m`);
  // Asked again (the statements are kept): the same.
  assert.deepEqual(index.lanes(at(0, 0), 0, after, "straight")?.lanes, info.lanes);
  // Told the route turns left: the left lane is the one.
  assert.deepEqual(index.lanes(at(0, 0), 0, after, "left")?.lanes, [{ turns: ["left"], best: true }, { turns: ["straight"], best: false }]);
  // Along the route: that junction, once, as a place where the right lane cannot go the route's way.
  const way: LonLat[] = [];
  for (let y = -200; y <= 160; y += 15) way.push(at(0, y));
  assert.equal(lanesAlong(index, way).length, 1);
  // Nothing far away.
  assert.equal(index.lanes(at(500, 500), 0, after, null), null);
});

test("lanesAlong reads the route only as far ahead as the guide does (40 points)", () => {
  const asked: number[] = [];
  const stub = { lanes: (_at: LonLat, _in: number, after: LonLat[]) => { asked.push(after.length); return null; } } as unknown as LaneIndex;
  const path: LonLat[] = [];
  for (let y = 0; y < 200 * 15; y += 15) path.push(at(0, y));
  lanesAlong(stub, path);
  assert.ok(asked.length > 50, "asked along the whole path");
  assert.ok(asked.every((n) => n <= AFTER_POINTS), `every ask at most ${AFTER_POINTS} points, saw ${Math.max(...asked)}`);
  assert.equal(Math.max(...asked), AFTER_POINTS);
});

test("a corner is threaded through the lane that turns the route's way: from the stop line, round the painted arc, on along the route", async () => {
  const index = await indexOf([
    // Two lanes north to the stop line at y = 0: the right one turns right, the left goes on.
    link({ id: "A219A000021", lane: 1, a: "P0", b: "P1", l: null, r: "A219A000022" }, [[-1.75, -100], [-1.75, -50], [-1.75, 0]]),
    link({ id: "A219A000022", lane: 2, a: "P0", b: "P2", l: "A219A000021", r: null }, [[1.75, -100], [1.75, -50], [1.75, 0]]),
    link({ id: "A219A000031", lane: 1, a: "P1", b: null, l: null, r: null }, [[-1.75, 0], [-1.75, 60], [-1.75, 160]]),
    // The right lane's arc: east through the junction, then along y = 20 (the cross street's lane).
    link({ id: "A219A000032", lane: 1, a: "P2", b: "P3", l: null, r: null }, [[1.75, 0], [6, 10], [14, 17], [24, 20]]),
    link({ id: "A219A000033", lane: 1, a: "P3", b: null, l: null, r: null }, [[24, 20], [80, 20], [200, 20]]),
  ]);
  // The provider's line: north up x = 0, one vertex at the corner (0, 20), then east — cutting the arc.
  const after: LonLat[] = [];
  for (let m = 0; m <= 150; m += 15) after.push(m <= 20 ? at(0, m) : at(m - 20, 20));
  const trail = index.thread(at(0, 20), 0, after);
  assert.ok(trail, "threaded");
  assert.equal(trail!.length, 4 + 3 - 1, "the stop line (the arc's own first point), the arc, then the cross street's lane");
  // It starts at the right lane's end and passes the arc's middle.
  const near = (p: LonLat, q: LonLat) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
  assert.ok(near(trail![0], at(1.75, 0)), JSON.stringify(trail![0]));
  assert.ok(near(trail![1], at(6, 10)), JSON.stringify(trail![1]));
  // A way in that no lane here takes (from the east) threads nothing.
  assert.equal(index.thread(at(0, 20), 270, after), null);
});

test("a route vertex is moved onto one lane running its way — a through lane, or the turn's side — not the oncoming ones; nowhere with no lanes", async () => {
  const index = await indexOf([
    // Two lanes north at x = 1.75 and 5.25 (the right side of the road), two south at x = -1.75 and -5.25.
    link({ id: "A219A000041", lane: 1, a: "Q0", b: "Q1", l: null, r: "A219A000042" }, [[1.75, -100], [1.75, 0], [1.75, 100]]),
    link({ id: "A219A000042", lane: 2, a: "Q0", b: "Q2", l: "A219A000041", r: null }, [[5.25, -100], [5.25, 0], [5.25, 100]]),
    link({ id: "A219A000043", lane: 1, a: "R0", b: "R1", l: null, r: null }, [[-1.75, 100], [-1.75, 0], [-1.75, -100]]),
    link({ id: "A219A000044", lane: 2, a: "R0", b: "R2", l: null, r: null }, [[-5.25, 100], [-5.25, 0], [-5.25, -100]]),
  ]);
  const [north, south, away, right] = index.snap([at(0, 50), at(0, 50), at(300, 50), at(0, 50)], [0, 180, 0, 0], [0, 0, 0, 1]);
  const xOf = (p: LonLat) => (p[0] - O[0]) * M * Math.cos((O[1] * Math.PI) / 180);
  // On a lane, never between two (the line was drawn on the paint between 2차로 and 3차로).
  assert.ok(north && Math.abs(xOf(north) - 5.25) < 0.05, `northbound on two lanes, going on → 2차로, not the left-turn and overtaking lane: ${north && xOf(north)}`);
  assert.ok(right && Math.abs(xOf(right) - 5.25) < 0.05, `northbound, a right turn ahead → the right lane: ${right && xOf(right)}`);
  // The southbound lanes are not each other's neighbours in this map: the nearest alone.
  assert.ok(south && Math.abs(xOf(south) + 1.75) < 0.05, `southbound → its nearest lane: ${south && xOf(south)}`);
  assert.equal(away, null);
});

test("with no turn ahead the line takes a through lane: 2차로 of two, the middle of three, left of the middle of four; a left turn ahead, 1차로", async () => {
  // Lanes north at x = 1.75 + 3.5k, neighbours of each other, for three roads apart: two lanes, three, four.
  const road = (id: string, x0: number, n: number) => Array.from({ length: n }, (_, k) =>
    link({ id: `A219D${id}${k}`, lane: k + 1, a: `${id}0`, b: `${id}${k + 1}`, l: k > 0 ? `A219D${id}${k - 1}` : null, r: k + 1 < n ? `A219D${id}${k + 1}` : null },
      [[x0 + 1.75 + 3.5 * k, -100], [x0 + 1.75 + 3.5 * k, 100]]));
  const index = await indexOf([...road("200", 0, 2), ...road("300", 1000, 3), ...road("400", 2000, 4)]);
  const xOf = (p: LonLat) => (p[0] - O[0]) * M * Math.cos((O[1] * Math.PI) / 180);
  const [two, three, four, twoLeft] = index.snap([at(0, 0), at(1000, 0), at(2000, 0), at(0, 0)], [0, 0, 0, 0], [0, 0, 0, -1]);
  assert.ok(two && Math.abs(xOf(two) - 5.25) < 0.05, `two lanes → 2차로: ${two && xOf(two)}`);
  assert.ok(three && Math.abs(xOf(three) - 1005.25) < 0.05, `three → 2차로: ${three && xOf(three)}`);
  assert.ok(four && Math.abs(xOf(four) - 2005.25) < 0.05, `four → 2차로: ${four && xOf(four)}`);
  assert.ok(twoLeft && Math.abs(xOf(twoLeft) - 1.75) < 0.05, `two, a left turn ahead → 1차로: ${twoLeft && xOf(twoLeft)}`);
});

test("a turn pocket beside 1차로 is not a lane of the road through: the middle of the three, not 1차로; a left turn ahead, the pocket", async () => {
  // Three lanes north at x = 1.75, 5.25, 8.75 to a stop line at y = 0; a pocket (91) opened left of 1차로 from y = -60.
  const lane = (k: number) => link({ id: `A223P00000${k}`, lane: k, a: "P0", b: `P${k}`, l: k > 1 ? `A223P00000${k - 1}` : "A223P000091", r: k < 3 ? `A223P00000${k + 1}` : null },
    [[1.75 + 3.5 * (k - 1), -100], [1.75 + 3.5 * (k - 1), 0]]);
  const index = await indexOf([
    lane(1), lane(2), lane(3),
    link({ id: "A223P000091", lane: 91, a: "Q0", b: "Q1", l: null, r: "A223P000001" }, [[-1.75, -60], [-1.75, 0]]),
    // Through the junction: the lanes straight on; the pocket turns round onto the southbound lanes (its U-turn).
    ...[1, 2, 3].map((k) => link({ id: `A223P00001${k}`, lane: k, a: `P${k}`, b: null, l: null, r: null }, [[1.75 + 3.5 * (k - 1), 0], [1.75 + 3.5 * (k - 1), 200]])),
    link({ id: "A223P000092", lane: 1, a: "Q1", b: null, l: null, r: null }, [[-1.75, 0], [-3, 8], [-6, 11], [-9, 8], [-10, 0], [-10, -150]]),
  ]);
  const xOf = (p: LonLat) => (p[0] - O[0]) * M * Math.cos((O[1] * Math.PI) / 180);
  // The route: north up the middle of the road, every 20 m, the provider's line on the centre line (x = 0).
  const ys = Array.from({ length: 16 }, (_, k) => -100 + 20 * k);
  const through = index.snap(ys.map((y) => at(0, y)), ys.map(() => 0), ys.map(() => 0));
  for (const [k, y] of ys.entries()) {
    const got = through[k];
    if (y > -60 && y < -10) assert.ok(got && Math.abs(xOf(got) - 5.25) < 0.05, `through at y=${y} → 2차로, not the pocket's neighbour: ${got && xOf(got)}`);
  }
  const left = index.snap([at(0, -30)], [0], [-1])[0];
  assert.ok(left && Math.abs(xOf(left) + 1.75) < 0.05, `a left turn ahead → the pocket: ${left && xOf(left)}`);
});

test("a left turn ahead, past a junction where 1차로 is left-only: up to that stop line the line is in the lane going straight there", async () => {
  // Two lanes north at x = 1.75, 5.25 to a stop line at y = 0; 1차로 only turns left there, 2차로 goes straight on to
  // y = 200, where the route turns left from 1차로 of the next pair.
  const index = await indexOf([
    link({ id: "A223W000001", lane: 1, a: "W0", b: "W1", l: null, r: "A223W000002" }, [[1.75, -150], [1.75, 0]]),
    link({ id: "A223W000002", lane: 2, a: "W0", b: "W2", l: "A223W000001", r: null }, [[5.25, -150], [5.25, 0]]),
    link({ id: "A223W000011", lane: 1, a: "W1", b: null, l: null, r: null }, [[1.75, 0], [-5, 12], [-30, 18], [-80, 20]]),
    link({ id: "A223W000012", lane: 2, a: "W2", b: "W3", l: null, r: null }, [[5.25, 0], [5.25, 30]]),
    link({ id: "A223W000021", lane: 1, a: "W3", b: "W4", l: null, r: "A223W000022" }, [[1.75, 30], [1.75, 200]]),
    link({ id: "A223W000022", lane: 2, a: "W3", b: "W5", l: "A223W000021", r: null }, [[5.25, 30], [5.25, 200]]),
    link({ id: "A223W000031", lane: 1, a: "W4", b: null, l: null, r: null }, [[1.75, 200], [-5, 212], [-30, 218], [-120, 220]]),
    link({ id: "A223W000032", lane: 2, a: "W5", b: null, l: null, r: null }, [[5.25, 200], [5.25, 400]]),
  ]);
  const xOf = (p: LonLat) => (p[0] - O[0]) * M * Math.cos((O[1] * Math.PI) / 180);
  // The route north on the centre line, left at y = 205; the left turn's side asked for all the way (its reach).
  const route: LonLat[] = [...Array.from({ length: 21 }, (_, k) => at(3.5, -150 + 15 * k)), at(3.5, 160), at(3.5, 190), at(-20, 215), at(-60, 218), at(-100, 220)];
  const headings = route.map((p, k) => { const q = route[Math.min(route.length - 1, k + 1)], o = route[Math.max(0, k - 1)]; return (Math.atan2(xOf(q) - xOf(o), (q[1] - o[1]) * M) * 180) / Math.PI; });
  const got = index.snap(route, headings, route.map(() => -1));
  const before = got[route.findIndex((p) => (p[1] - O[1]) * M >= -30)];
  assert.ok(before && Math.abs(xOf(before) - 5.25) < 0.05, `30 m before the left-only stop line → 2차로: ${before && xOf(before)}`);
  const later = got[route.findIndex((p) => (p[1] - O[1]) * M >= 150)];
  assert.ok(later && Math.abs(xOf(later) - 1.75) < 0.05, `before the turn itself → 1차로: ${later && xOf(later)}`);
});

test("an exit ramp just parted from the motorway is its own road: the line stays on it, not taken back to the motorway's middle", async () => {
  const index = await indexOf([
    // Three motorway lanes north at x = 0, 3.5, 7; the ramp 9 m right of the outer one, neighbour to none.
    link({ id: "A219C000001", lane: 1, a: "T0", b: "T1", l: null, r: "A219C000002" }, [[0, -100], [0, 100]]),
    link({ id: "A219C000002", lane: 2, a: "T0", b: "T2", l: "A219C000001", r: "A219C000003" }, [[3.5, -100], [3.5, 100]]),
    link({ id: "A219C000003", lane: 3, a: "T0", b: "T3", l: "A219C000002", r: null }, [[7, -100], [7, 100]]),
    link({ id: "A219C000004", lane: 1, a: "T4", b: "T5", l: null, r: null }, [[16, -100], [16, 100]]),
  ]);
  const [onRamp] = index.snap([at(16.5, 0)], [0]);
  const xOf = (p: LonLat) => (p[0] - O[0]) * M * Math.cos((O[1] * Math.PI) / 180);
  assert.ok(onRamp && Math.abs(xOf(onRamp) - 16) < 0.05, `on the ramp: ${onRamp && xOf(onRamp)}`);
});

test("a 도류화 right turn: the slip lane leaves before the stop line, and is found from the lanes under the route", async () => {
  const index = await indexOf([
    // North to a stop line at y = 0: the through lane, and the outer lane that splits off at y = -40 into a slip road east.
    link({ id: "A219B000001", lane: 1, a: "S0", b: "S1", l: null, r: null }, [[1.75, -120], [1.75, -60], [1.75, 0]]),
    link({ id: "A219B000002", lane: 2, a: "S0", b: "S2", l: null, r: null }, [[5.25, -120], [5.25, -40]]),
    link({ id: "A219B000003", lane: 1, a: "S2", b: "S3", l: null, r: null }, [[5.25, -40], [8, -25], [14, -14], [24, -9]]),
    // East from the slip, the eastbound road's outer lane 9 m south of the route's line.
    link({ id: "A219B000004", lane: 1, a: "S3", b: null, l: null, r: null }, [[24, -9], [80, -9], [200, -9]]),
    link({ id: "A219B000005", lane: 1, a: "S1", b: null, l: null, r: null }, [[1.75, 0], [1.75, 100], [1.75, 200]]),
  ]);
  // The provider's line: north up the middle to the junction's centre, then east along the middle of the road at y = 0.
  const before: LonLat[] = [], after: LonLat[] = [];
  for (let y = -80; y <= 0; y += 5) before.push(at(0, y));
  for (let x = 0; x <= 150; x += 15) after.push(at(x, 0));
  // Its lane ends at the stop line turn the other way, so the lane ends find nothing.
  assert.equal(index.thread(at(0, 0), 0, after), null);
  const trail = index.threadAlong(before, after);
  assert.ok(trail, "found along the route");
  // It goes by the slip road: east of the through lane before the junction, and on the eastbound lane after it.
  const xy = (p: LonLat) => [(p[0] - O[0]) * M * Math.cos((O[1] * Math.PI) / 180), (p[1] - O[1]) * M];
  // Through the slip: some point well east of the through lane while still south of the junction.
  assert.ok(trail!.some((p) => { const [x, y] = xy(p); return x > 6 && x < 22 && y > -30 && y < -10; }), "through the slip");
  // And on along the eastbound lane, 9 m south of the line.
  assert.ok(trail!.some((p) => { const [x, y] = xy(p); return x > 60 && Math.abs(y + 9) < 1; }), "on the eastbound lane");
  assert.ok(!trail!.some((p) => xy(p)[1] > 5), "never north of the junction");
});

test("at a seam between two surveys the walk goes on: the 2023 road's lane ends 40 m short and the 2022 junction's slip lane starts a step on", async () => {
  const index = await indexOf([
    // 2023's survey: the outer lane north to y = -45, its end node named in nothing of 2022's.
    link({ id: "A223B000001", lane: 1, a: "N0", b: "N1", l: null, r: null }, [[5.25, -120], [5.25, -45]]),
    // 2022's: on from 1.5 m further, the slip lane and the eastbound road after it.
    link({ id: "A222B000002", lane: 1, a: "M0", b: "M1", l: null, r: null }, [[5.4, -43.5], [5.25, -40]]),
    link({ id: "A222B000003", lane: 1, a: "M1", b: "M2", l: null, r: null }, [[5.25, -40], [8, -25], [14, -14], [24, -9]]),
    link({ id: "A222B000004", lane: 1, a: "M2", b: null, l: null, r: null }, [[24, -9], [80, -9], [200, -9]]),
  ]);
  const before: LonLat[] = [], after: LonLat[] = [];
  for (let y = -80; y <= 0; y += 5) before.push(at(0, y));
  for (let x = 0; x <= 150; x += 15) after.push(at(x, 0));
  const trail = index.threadAlong(before, after);
  assert.ok(trail, "found across the seam");
  const xy = (p: LonLat) => [(p[0] - O[0]) * M * Math.cos((O[1] * Math.PI) / 180), (p[1] - O[1]) * M];
  assert.ok(trail!.some((p) => { const [x, y] = xy(p); return x > 6 && x < 22 && y > -30 && y < -10; }), "through the slip");
});

test("turning right, a slip lane is taken before the way through the junction, though that keeps nearer the provider's line", async () => {
  const index = await indexOf([
    link({ id: "A219C000001", lane: 1, a: "S0", b: "S1", l: null, r: null }, [[5.25, -120], [5.25, -40]]),
    // The slip lane, wide of the corner…
    link({ id: "A219C000002", lane: 1, a: "S1", b: "S3", l: null, r: null }, [[5.25, -40], [8, -25], [14, -14], [24, -9]]),
    // …and the outer lane on to the stop line and round the junction's corner, close by the provider's.
    link({ id: "A219C000003", lane: 1, a: "S1", b: "S2", l: null, r: null }, [[5.25, -40], [5.25, -6]]),
    link({ id: "A219C000004", lane: 1, a: "S2", b: "S3b", l: null, r: null }, [[5.25, -6], [6, -2], [9, -1], [24, -3]]),
    link({ id: "A219C000005", lane: 1, a: "S3", b: null, l: null, r: null }, [[24, -9], [80, -6], [200, -6]]),
    link({ id: "A219C000006", lane: 1, a: "S3b", b: null, l: null, r: null }, [[24, -3], [80, -6], [200, -6]]),
  ]);
  const before: LonLat[] = [], after: LonLat[] = [];
  for (let y = -80; y <= 0; y += 5) before.push(at(0, y));
  for (let x = 0; x <= 150; x += 15) after.push(at(x, 0));
  const trail = index.threadAlong(before, after)!;
  const xy = (p: LonLat) => [(p[0] - O[0]) * M * Math.cos((O[1] * Math.PI) / 180), (p[1] - O[1]) * M];
  assert.ok(trail.some((p) => { const [x, y] = xy(p); return x > 8 && x < 20 && y > -25 && y < -12; }), "by the slip lane");
});

test("the line keeps to lanes of the route's road: not a deceleration lane beside it that leaves for another exit, nor a loop ramp just come alongside from a newer survey", async () => {
  // A motorway north, three lanes (2023), from y = -800 to 400. On its right an exit lane runs beside it from -600 and
  // leaves at -100 for another exit; further on a loop ramp (2024's survey) comes in from the east and runs beside it.
  const main = (n: number, x: number, l: string | null, r: string | null) =>
    link({ id: `A223M00000${n}`, lane: n, a: `M${n}a`, b: `M${n}b`, l, r }, [[x, -800], [x, -200], [x, 400]]);
  const index = await indexOf([
    main(1, -3.5, null, "A223M000002"),
    main(2, 0, "A223M000001", "A223M000003"),
    main(3, 3.5, "A223M000002", "A223E000001"),
    link({ id: "A223E000001", lane: 4, a: "E0", b: "E1", l: "A223M000003", r: null }, [[7, -600], [7, -100], [30, -20], [80, 40]]),
    link({ id: "A224L000001", lane: 1, a: "L0", b: "L1", l: null, r: null }, [[60, 100], [25, 150], [7, 180], [7, 400]]),
  ]);
  // The provider's line up the middle; a right turn ahead past the end (the line held to the right).
  const ys: number[] = [];
  for (let y = -700; y <= 380; y += 20) ys.push(y);
  const got = index.snap(ys.map((y) => at(1, y)), ys.map(() => 0), ys.map(() => 1));
  const xOf = (y: number) => { const p = got[ys.indexOf(y)]!; return Math.round(((p[0] - O[0]) * M * Math.cos((O[1] * Math.PI) / 180)) * 10) / 10; };
  assert.equal(xOf(-400), 3.5, "beside the exit lane: the rightmost lane that goes on, not the one that leaves");
  assert.equal(xOf(-140), 3.5);
  assert.equal(xOf(200), 3.5, "beside the loop ramp: the motorway's lane, though the ramp is the newer survey");
  // Near the end of the points asked every lane runs past it: still a lane, on the right.
  assert.equal(xOf(380), 7, "the loop ramp, 200 m on, runs with the route: the rightmost");
});

test("a left turn where the map has no links through the junction is bridged: from 1차로's end, straight in, round, into the leftmost lane out", async () => {
  // Three lanes north to a stop line at y = 0, nothing on from them; the road turned into runs west from x = -20 on,
  // its westbound lanes on its north side, 1차로 by the centre line at y = 23.25 and 2차로 at y = 26.75, the eastbound
  // south of them; no lanes on the road east.
  const index = await indexOf([
    link({ id: "A223A000001", lane: 1, a: "S1", b: "E1", l: null, r: "A223A000002" }, [[-5.25, -120], [-5.25, 0]]),
    link({ id: "A223A000002", lane: 2, a: "S2", b: "E2", l: "A223A000001", r: "A223A000003" }, [[-1.75, -120], [-1.75, 0]]),
    link({ id: "A223A000003", lane: 3, a: "S3", b: "E3", l: "A223A000002", r: null }, [[1.75, -120], [1.75, 0]]),
    link({ id: "A223A000011", lane: 1, a: "W1", b: "W9", l: null, r: "A223A000012" }, [[-20, 23.25], [-200, 23.25]]),
    link({ id: "A223A000012", lane: 2, a: "W2", b: "W8", l: "A223A000011", r: null }, [[-20, 26.75], [-200, 26.75]]),
    link({ id: "A223A000021", lane: 1, a: "V1", b: "V9", l: null, r: null }, [[-200, 19.75], [-20, 19.75]]),
  ]);
  const after: LonLat[] = [];
  for (let x = 0; x >= -200; x -= 15) after.push(at(x, 25));
  assert.equal(index.thread(at(0, 25), 0, after), null, "no links through it to thread");
  const trail = index.bridge(at(0, 25), 0, after);
  assert.ok(trail, "bridged");
  const xy = trail.map((p) => [(p[0] - O[0]) * M * Math.cos((O[1] * Math.PI) / 180), (p[1] - O[1]) * M]);
  const near = (x: number, y: number, m = 0.6) => xy.some(([a, b]) => Math.hypot(a - x, b - y) < m);
  assert.ok(near(-5.25, 0), "from 1차로's end at the stop line");
  assert.ok(near(-5.25, -80), "and from 80 m up 1차로 before it");
  assert.ok(xy.every(([x, y]) => y < 0.5 || x < -5 || Math.abs(x + 5.25) < 0.5), "on straight into the junction first");
  const onTrail = (x: number, y: number) => xy.some(([ax, ay], i) => {
    if (i === 0) return false;
    const [bx, by] = xy[i - 1], dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(ax + t * dx - x, ay + t * dy - y) < 0.6;
  });
  assert.ok(onTrail(-60, 23.25), "out in the westbound 1차로");
  assert.ok(xy.every(([x, y]) => x > -25 || Math.abs(y - 23.25) < 0.5), "in it from the junction's edge on, not over in the eastbound lanes");
  // Turning one way only: the heading only ever comes round to the left.
  for (let i = 2; i < xy.length; i++) {
    const h = (a: number[], b: number[]) => Math.atan2(b[0] - a[0], b[1] - a[1]);
    const d = ((h(xy[i - 1], xy[i]) - h(xy[i - 2], xy[i - 1]) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    assert.ok(d < 0.05, `bends right at ${xy[i - 1].map((v) => v.toFixed(1))}`);
  }
  // A right turn there finds no lanes out: none.
  const east: LonLat[] = [];
  for (let x = 0; x <= 200; x += 15) east.push(at(x, 25));
  assert.equal(index.bridge(at(0, 25), 0, east), null);
});
