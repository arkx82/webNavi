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
  assert.equal(trail!.length, 4 + 3 - 1 + 1, "the stop line, the arc, then the cross street's lane");
  // It starts at the right lane's end and passes the arc's middle.
  const near = (p: LonLat, q: LonLat) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
  assert.ok(near(trail![0], at(1.75, 0)), JSON.stringify(trail![0]));
  assert.ok(near(trail![2], at(6, 10)), JSON.stringify(trail![2]));
  // A way in that no lane here takes (from the east) threads nothing.
  assert.equal(index.thread(at(0, 20), 270, after), null);
});

test("a route vertex is moved to the middle of the lanes running its way, not the oncoming ones; nowhere with no lanes", async () => {
  const index = await indexOf([
    // Two lanes north at x = 1.75 and 5.25 (the right side of the road), two south at x = -1.75 and -5.25.
    link({ id: "A219A000041", lane: 1, a: "Q0", b: "Q1", l: null, r: "A219A000042" }, [[1.75, -100], [1.75, 0], [1.75, 100]]),
    link({ id: "A219A000042", lane: 2, a: "Q0", b: "Q2", l: "A219A000041", r: null }, [[5.25, -100], [5.25, 0], [5.25, 100]]),
    link({ id: "A219A000043", lane: 1, a: "R0", b: "R1", l: null, r: null }, [[-1.75, 100], [-1.75, 0], [-1.75, -100]]),
    link({ id: "A219A000044", lane: 2, a: "R0", b: "R2", l: null, r: null }, [[-5.25, 100], [-5.25, 0], [-5.25, -100]]),
  ]);
  const [north, south, away] = index.snap([at(0, 50), at(0, 50), at(300, 50)], [0, 180, 0]);
  const xOf = (p: LonLat) => (p[0] - O[0]) * M * Math.cos((O[1] * Math.PI) / 180);
  assert.ok(north && Math.abs(xOf(north) - 3.5) < 0.05, `northbound → 3.5 m right: ${north && xOf(north)}`);
  assert.ok(south && Math.abs(xOf(south) + 3.5) < 0.05, `southbound → 3.5 m left: ${south && xOf(south)}`);
  assert.equal(away, null);
});
