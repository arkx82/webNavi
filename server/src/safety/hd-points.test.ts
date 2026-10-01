import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HdPoints, featureOf, isCarLight } from "./hd-points.js";

test("a car's light by either schema's code; a walker's is not one", () => {
  assert.ok(isCarLight("1") && isCarLight("2") && isCarLight("5") && isCarLight(1));
  assert.ok(!isCarLight("11") && !isCarLight("99"));
  assert.ok(isCarLight("100") && isCarLight("101") && isCarLight("140"));
  assert.ok(!isCarLight("201") && !isCarLight("300"));
  assert.ok(isCarLight(undefined), "no code: taken");
});

test("a light is a point, a bump the middle of its polygon; ids keep the source apart", () => {
  const light = featureOf("lights", { properties: { id: "C119A1", t: "1" }, geometry: { type: "Point", coordinates: [127.1, 37.5, 40] } });
  assert.deepEqual(light, { id: "hd:light:C119A1", kind: "signal-light", lon: 127.1, lat: 37.5 });
  assert.equal(featureOf("lights", { properties: { id: "C119A2", t: "11" }, geometry: { type: "Point", coordinates: [127.1, 37.5] } }), null);
  const bump = featureOf("bumps", { properties: { id: "C419B1" }, geometry: { type: "MultiPolygon", coordinates: [[[[127, 37], [127.0002, 37], [127.0002, 37.0001], [127, 37.0001], [127, 37]]]] } });
  assert.ok(bump && bump.kind === "bump" && Math.abs(bump.lon - 127.0001) < 1e-9 && Math.abs(bump.lat - 37.00005) < 1e-9);
});

test("read from the files, and a public point within 20 m of an HD one of the same kind is left out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdpoints-"));
  writeFileSync(join(dir, "lights.geojsons"), [
    JSON.stringify({ type: "Feature", properties: { id: "L1", t: "1" }, geometry: { type: "Point", coordinates: [127.0276, 37.4979] } }),
    JSON.stringify({ type: "Feature", properties: { id: "L2", t: "11" }, geometry: { type: "Point", coordinates: [127.03, 37.5] } }),
  ].join("\n") + "\n");
  const hd = new HdPoints(dir);
  assert.equal(await hd.refresh(), true);
  assert.equal(hd.features.length, 1);
  assert.equal(await hd.refresh(), false, "unchanged files: nothing to do");
  const pub = [
    { id: "p1", kind: "signal-light" as const, lon: 127.02761, lat: 37.49795 },  // 6 m off L1: the HD one stands
    { id: "p2", kind: "signal-light" as const, lon: 127.0286, lat: 37.4979 },    // 90 m: its own
    { id: "p3", kind: "bump" as const, lon: 127.0276, lat: 37.4979 },            // another kind at the same spot: kept
  ];
  assert.deepEqual(hd.without(pub).map((f) => f.id), ["p2", "p3"]);
});
