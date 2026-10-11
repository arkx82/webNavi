import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARROW_TURNS, ArrowIndex } from "./arrows.js";
import { LaneIndex, turnOfTrail } from "./lanes.js";
import type { LonLat } from "./route/types.js";

// A junction laid out in metres about a point in Seoul, put into lon/lat (as lanes.test.ts does).
const O: LonLat = [127.0, 37.5];
const M = 111_320;
const KX = M * Math.cos((O[1] * Math.PI) / 180);
const at = (x: number, y: number): LonLat => [O[0] + x / KX, O[1] + y / M];
const link = (p: Record<string, string | number | null>, pts: [number, number][]) =>
  JSON.stringify({ type: "Feature", properties: p, geometry: { type: "LineString", coordinates: pts.map(([x, y]) => at(x, y)) } });
/** An arrow painted in a lane: a 1.2 × 5 m box about (x, y), of kind [k] (5373 우회전 …), as marks.geojsons has it. */
const mark = (k: string | number, x: number, y: number) => JSON.stringify({
  type: "Feature",
  properties: { t: "1", k },
  geometry: { type: "MultiPolygon", coordinates: [[[at(x - 0.6, y - 2.5), at(x + 0.6, y - 2.5), at(x + 0.6, y + 2.5), at(x - 0.6, y + 2.5), at(x - 0.6, y - 2.5)]]] },
});

async function indexWith(lines: string[], marks: string[] | null): Promise<LaneIndex> {
  const dir = mkdtempSync(join(tmpdir(), "lanes-"));
  writeFileSync(join(dir, "links.geojsons"), lines.join("\n") + "\n");
  let arrows: ArrowIndex | null = null;
  if (marks) {
    writeFileSync(join(dir, "marks.geojsons"), marks.join("\n") + "\n");
    arrows = new ArrowIndex(join(dir, "marks.geojsons"), join(dir, "arrows.db"));
    await arrows.refresh();
    assert.ok(arrows.ready);
  }
  const index = new LaneIndex(join(dir, "links.geojsons"), join(dir, "lanes.db"), () => {}, arrows);
  await index.refresh();
  return index;
}
/** Two lanes north to a stop line at y = 0, the left one into a left turn; the right one's links through given. */
const twoLanes = (rightOn: string[]) => [
  link({ id: "A219D000001", lane: 1, a: "D0", b: "D1", l: null, r: "A219D000002" }, [[-1.75, -100], [-1.75, -50], [-1.75, 0]]),
  link({ id: "A219D000002", lane: 2, a: "D0", b: "D2", l: "A219D000001", r: null }, [[1.75, -100], [1.75, -50], [1.75, 0]]),
  link({ id: "A219D000011", lane: 1, a: "D1", b: null, l: null, r: null }, [[-1.75, 0], [-10, 15], [-40, 25], [-80, 27]]),
  ...rightOn,
];
const straightOn = link({ id: "A219D000012", lane: 1, a: "D2", b: null, l: null, r: null }, [[1.75, 0], [1.75, 60], [1.75, 160]]);
const north = (to = 160): LonLat[] => { const p: LonLat[] = []; for (let y = 0; y <= to; y += 15) p.push(at(0, y)); return p; };
const turnsOf = (info: { lanes: { turns: string[] }[] } | null) => info?.lanes.map((l) => l.turns.join("+"));

test("the arrows are built from the road markings: a point each, the direction arrows only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrows-"));
  writeFileSync(join(dir, "marks.geojsons"), [mark("5373", 1.75, -10), mark(5371, -1.75, -10), mark("5321", 0, 5), "not json {\"k\":\"5371\""].join("\n") + "\n");
  const arrows = new ArrowIndex(join(dir, "marks.geojsons"), join(dir, "arrows.db"));
  assert.equal(arrows.ready, false);
  assert.deepEqual(arrows.within(0, 0, 1, 1), [], "nothing before it is built");
  await arrows.refresh();
  const [w, s] = at(-20, -20), [e, n] = at(20, 20);
  const found = arrows.within(w, s, e, n).sort((a, b) => a.code - b.code);
  assert.deepEqual(found.map((a) => a.code), [5371, 5373], "the crosswalk (5321) and the broken line left out");
  const x = (found[1].at[0] - O[0]) * KX, y = (found[1].at[1] - O[1]) * M;
  assert.ok(Math.abs(x - 1.75) < 0.05 && Math.abs(y + 10) < 0.05, `the arrow's middle: ${x}, ${y}`);
  assert.deepEqual(ARROW_TURNS[5373], ["right"]);
  assert.deepEqual(ARROW_TURNS[5392], ["uturn", "left"]);
});

test("a lane is read by its painted arrow first: an outer lane painted 우회전 whose link runs on straight is a right-turn lane", async () => {
  // The arrow nearest the stop line decides: 직진 64 m back (before the pocket opened), 우회전 at 8 m.
  const painted = await indexWith(twoLanes([straightOn]), [mark(5371, 1.75, -64), mark(5373, 1.75, -8)]);
  const info = painted.lanes(at(0, 0), 0, north(), "right");
  assert.deepEqual(turnsOf(info), ["left", "right"]);
  assert.deepEqual(info?.lanes.map((l) => l.best), [false, true]);
  // Without an arrows file, the links alone: the left lane's turns left, the right lane's goes on.
  const bare = await indexWith(twoLanes([straightOn]), null);
  assert.deepEqual(turnsOf(bare.lanes(at(0, 0), 0, north(), "straight")), ["left", "straight"]);
  // An arrow of the next lane over (3.5 m off) is not this lane's; nor one 70 m back.
  const beside = await indexWith(twoLanes([straightOn]), [mark(5373, 5.25, -8), mark(5373, 1.75, -70)]);
  assert.deepEqual(turnsOf(beside.lanes(at(0, 0), 0, north(), "straight")), ["left", "straight"]);
});

test("paint out of order is the map's slip: a 좌회전 arrow on the outermost lane, right of one painted 직진, is read by its link", async () => {
  // (The left lane's link turns left, but it is painted 직진: the paint is its.)
  const index = await indexWith(twoLanes([straightOn]), [mark(5371, -1.75, -6), mark(5372, 1.75, -6)]);
  assert.deepEqual(turnsOf(index.lanes(at(0, 0), 0, north(), "straight")), ["straight", "straight"]);
});

test("where every lane's link runs straight on (a lane parting before the stop line), the paint is the stop line's ahead and not read", async () => {
  const lines = [
    link({ id: "A219D000021", lane: 1, a: "E0", b: "E1", l: null, r: "A219D000022" }, [[-1.75, -100], [-1.75, 0]]),
    link({ id: "A219D000022", lane: 2, a: "E0", b: "E2", l: "A219D000021", r: null }, [[1.75, -100], [1.75, 0]]),
    link({ id: "A219D000031", lane: 1, a: "E1", b: null, l: null, r: "A219D000032" }, [[-1.75, 0], [-1.75, 160]]),
    link({ id: "A219D000032", lane: 2, a: "E2", b: null, l: "A219D000031", r: null }, [[1.75, 0], [1.75, 160]]),
  ];
  const index = await indexWith(lines, [mark(5373, 1.75, -6)]);
  // Every lane straight on and every one the route's: nothing to tell (read by the paint, the right lane would turn).
  assert.equal(index.lanes(at(0, 0), 0, north(), "straight"), null);
});

test("a link through the junction that stops within 60 m, bent 10° or more, is a turn that way; a long one, or one that goes on, is read at 40 m", async () => {
  // 30 m at 20° to the right, and nothing after it (a side road the map does not have).
  const short = link({ id: "A219D000012", lane: 1, a: "D2", b: null, l: null, r: null }, [[1.75, 0], [1.75 + 30 * Math.sin(Math.PI / 9), 30 * Math.cos(Math.PI / 9)]]);
  const index = await indexWith(twoLanes([short]), null);
  assert.deepEqual(turnsOf(index.lanes(at(0, 0), 0, north(), "right")), ["left", "right"]);
  const end = at(0, 0);
  const ray = (m: number, deg: number): LonLat[] => [end, at(m * Math.sin((deg * Math.PI) / 180), m * Math.cos((deg * Math.PI) / 180))];
  assert.equal(turnOfTrail(0, end, ray(30, 20), true), "right");
  assert.equal(turnOfTrail(0, end, ray(30, -12), true), "left");
  assert.equal(turnOfTrail(0, end, ray(30, 8), true), "straight", "under 10°");
  assert.equal(turnOfTrail(0, end, ray(90, 20), true), "straight", "past 60 m: a road that bends");
  assert.equal(turnOfTrail(0, end, ray(30, 20), false), "straight", "links going on: read at 40 m as before");
  assert.equal(turnOfTrail(0, end, ray(30, 45), false), "right");
});

test("following a lane's links stops at a loop: a right turn into a P-turn is a right turn, not straight, left or a U-turn", async () => {
  const pturn = [
    // The right turn: 12 m, bending 45° to the right …
    link({ id: "A219D000012", lane: 1, a: "D2", b: "D3", l: null, r: null }, [[1.75, 0], [3, 6], [7, 10]]),
    // … then round to the left and back the way it came: at 40 m 11° off, at its end -15°.
    link({ id: "A219D000013", lane: 1, a: "D3", b: null, l: null, r: null }, [[7, 10], [12, 13], [15, 18], [15, 24], [12, 29], [7, 31], [2, 30], [-2, 26], [-4, 21]]),
  ];
  const index = await indexWith(twoLanes(pturn), null);
  assert.deepEqual(turnsOf(index.lanes(at(0, 0), 0, north(), "right")), ["left", "right"]);
});

test("a U-turn drawn as two links (3 m on, then round to the left) is followed round and stays a U-turn", async () => {
  const lines = [
    link({ id: "A219D000021", lane: 1, a: "F0", b: "F1", l: null, r: "A219D000022" }, [[-1.75, -100], [-1.75, 0]]),
    link({ id: "A219D000022", lane: 2, a: "F0", b: "F2", l: "A219D000021", r: null }, [[1.75, -100], [1.75, 0]]),
    link({ id: "A219D000031", lane: 1, a: "F1", b: "F3", l: null, r: null }, [[-1.75, 0], [-1.75, 3]]),
    link({ id: "A219D000033", lane: 1, a: "F3", b: null, l: null, r: null }, [[-1.75, 3], [-3, 7], [-6, 9], [-9, 8], [-10, 5], [-10, 0], [-10, -60]]),
    link({ id: "A219D000032", lane: 1, a: "F2", b: null, l: null, r: null }, [[1.75, 0], [1.75, 160]]),
  ];
  const index = await indexWith(lines, null);
  assert.deepEqual(turnsOf(index.lanes(at(0, 0), 0, north(), "straight")), ["uturn", "straight"]);
});

test("where no lane reads as going the guide's way, the lane whose way on keeps nearest the route is the one; nothing far from the route", async () => {
  // Both lanes sweep left, 3° in the first 40 m and 35° by 140: read as straight on at 40 m.
  const sweep = (x: number, id: string, a: string): string => link({ id, lane: 1, a, b: null, l: null, r: null }, [[x, 0], [x - 2, 40], [x - 15, 90], [x - 50, 140]]);
  const lines = [
    link({ id: "A219D000041", lane: 1, a: "G0", b: "G1", l: null, r: "A219D000042" }, [[-1.75, -100], [-1.75, 0]]),
    link({ id: "A219D000042", lane: 2, a: "G0", b: "G2", l: "A219D000041", r: null }, [[1.75, -100], [1.75, 0]]),
    sweep(-1.75, "A219D000051", "G1"),
    sweep(1.75, "A219D000052", "G2"),
  ];
  // The route's line on the right lane's way.
  const route: LonLat[] = [at(1.75, 0), at(-0.25, 40), at(-13.25, 90), at(-48.25, 140)];
  const index = await indexWith(lines, null);
  assert.deepEqual(index.lanes(at(0, 0), 0, route, "left")?.lanes, [{ turns: ["straight"], best: false }, { turns: ["left", "straight"], best: true }]);
  // Told nothing (the way along the route), no lane is picked so.
  assert.equal(index.lanes(at(0, 0), 0, route, null), null);
  // The route 30 m east of every lane: another road's stop line, nothing.
  assert.equal(index.lanes(at(0, 0), 0, route.map(([lon, lat]) => [lon + 30 / KX, lat] as LonLat), "left"), null);
});
