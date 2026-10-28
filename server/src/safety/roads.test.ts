import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CameraRoads, ROADS_VERSION, pickCarriageways, sameRoad, waysFrom } from "./roads.js";
import type { Feature } from "./index.js";

test("a camera's road name and the graph's are one road: spacing, a name inside the other, a renamed motorway", () => {
  assert.ok(sameRoad("구리-포천고속도로", "구리포천고속도로"));
  assert.ok(sameRoad("구리-포천고속도로", "세종포천고속도로"));
  assert.ok(sameRoad("동부간선도로", "동부간선"));
  assert.ok(!sameRoad("호국로", "용민로489번길"));
  assert.ok(!sameRoad("구리-포천고속도로", "용민로"));
  assert.ok(!sameRoad("", "세종포천고속도로"));
});

// What the graph answered round 구리포천고속도로's G5870 (2026-10-11): the motorway 143 m off both ways, streets further.
const g5870 = [
  { deg: 0, at: [127.121407, 37.75275] as [number, number], d: 143, name: "세종포천고속도로", first: true },
  { deg: 0, at: [127.12141, 37.75276] as [number, number], d: 144, name: "세종포천고속도로", first: false },
  { deg: 90, at: [127.1255, 37.7531] as [number, number], d: 287, name: "용민로489번길", first: true },
  { deg: 180, at: [127.121277, 37.752719] as [number, number], d: 155, name: "세종포천고속도로", first: true },
  { deg: 270, at: [127.1199, 37.7531] as [number, number], d: 271, name: "용민로489번길", first: true },
];

test("a camera near a road is on the nearest, as before; one far off is on a road of its name, both carriageways (G5870, 143 m off)", () => {
  assert.deepEqual(waysFrom([{ deg: 0, at: [1, 2], d: 5, first: true }, { deg: 180, at: [1, 2], d: 7, first: true }, { deg: 90, at: [3, 4], d: 20, first: true }], "호국로"), [{ deg: 0, at: [1, 2] }, { deg: 180, at: [1, 2] }]);
  assert.deepEqual(waysFrom(g5870, "구리-포천고속도로"), [{ deg: 0, at: [127.121407, 37.75275], far: true }, { deg: 180, at: [127.121277, 37.752719], far: true }]);
  // No road of its name: none, as before.
  assert.equal(waysFrom(g5870, "호국로"), null);
  // A street camera that far off its street is a junction's, not the nearest point of the street (양문사거리's, 240 m off).
  assert.equal(waysFrom([{ deg: 0, at: [1, 2], d: 240, name: "호국로", first: true }], "호국로"), null);
  assert.deepEqual(waysFrom([{ deg: 0, at: [1, 2], d: 40, name: "호국로", first: true }], "호국로"), [{ deg: 0, at: [1, 2], far: true }]);
});

test("a camera far off its road is put on the carriageway its agency's nearest camera of that road and direction code stands on", () => {
  const far: Feature = { id: "police-api:1320000-G5870", kind: "speed", lon: 127.1229661, lat: 37.7531121, direction: "2", name: "구리-포천고속도로",
    ways: [{ deg: 0, at: [127.121407, 37.75275], far: true }, { deg: 180, at: [127.121277, 37.752719], far: true }] };
  const neighbours: Feature[] = [
    { id: "police-api:1320000-G5871", kind: "speed", lon: 127.148, lat: 37.8174, direction: "2", name: "구리-포천고속도로", ways: [{ deg: 225, at: [127.148, 37.8174] }] },
    { id: "police-api:1320000-H3609", kind: "speed", lon: 127.12, lat: 37.712, direction: "1", name: "구리포천고속도로", ways: [{ deg: 0, at: [127.12, 37.712] }] },
  ];
  assert.deepEqual(pickCarriageways([far, ...neighbours])[0].ways, [{ deg: 180, at: [127.121277, 37.752719], far: true }]);
  // None of its agency, road and code near: both kept.
  assert.equal(pickCarriageways([far, neighbours[1]])[0].ways?.length, 2);
});

test("an older roads file has its cameras put on no road asked again; the file says its version", () => {
  const dir = mkdtempSync(join(tmpdir(), "roads-"));
  writeFileSync(join(dir, "camera-roads.json"), JSON.stringify({ a: null, b: [{ deg: 0, at: [1, 2] }] }));
  const old = new CameraRoads(dir, () => undefined);
  assert.deepEqual(old.apply([{ id: "a", kind: "speed", lon: 1, lat: 2 }, { id: "b", kind: "speed", lon: 1, lat: 2 }]).map((f) => f.ways?.length ?? 0), [0, 1]);
  // Asked: "a" is not in the kept list any more, so fill() would ask it (no graph here, so nothing is asked).
  assert.ok(!("a" in (old as unknown as { kept: Record<string, unknown> }).kept));
  writeFileSync(join(dir, "camera-roads.json"), JSON.stringify({ "#v": ROADS_VERSION, a: null }));
  const current = new CameraRoads(dir, () => undefined);
  assert.ok("a" in (current as unknown as { kept: Record<string, unknown> }).kept);
  (current as unknown as { save(): void }).save();
  assert.equal(JSON.parse(readFileSync(join(dir, "camera-roads.json"), "utf8"))["#v"], ROADS_VERSION);
});
