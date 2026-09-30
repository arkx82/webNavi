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
