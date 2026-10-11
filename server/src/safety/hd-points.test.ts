import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

/** A lanes.db as server/src/lanes.ts builds it, with these links. */
function lanesDb(file: string, links: { id: string; coords: [number, number][] }[]) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE links (rowid INTEGER PRIMARY KEY, id TEXT, lane INTEGER, a TEXT, b TEXT, l TEXT, r TEXT, coords TEXT);
    CREATE VIRTUAL TABLE box USING rtree(rowid, minx, maxx, miny, maxy);`);
  for (const l of links) {
    const r = db.prepare("INSERT INTO links (id, lane, coords) VALUES (?, 1, ?)").run(l.id, JSON.stringify(l.coords));
    const xs = l.coords.map((c) => c[0]), ys = l.coords.map((c) => c[1]);
    db.prepare("INSERT INTO box VALUES (?, ?, ?, ?, ?)").run(r.lastInsertRowid, Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys));
  }
  db.close();
}

/** A square bump polygon 4 m a side round (lon, lat). */
function bumpAt(id: string, lon: number, lat: number, link?: string) {
  const dx = 2 / (111_320 * Math.cos((lat * Math.PI) / 180)), dy = 2 / 111_320;
  const ring = [[lon - dx, lat - dy], [lon + dx, lat - dy], [lon + dx, lat + dy], [lon - dx, lat + dy], [lon - dx, lat - dy]];
  return JSON.stringify({ type: "Feature", properties: link ? { id, link } : { id }, geometry: { type: "MultiPolygon", coordinates: [[ring]] } });
}

test("each bump carries the lane it lies on: an HD bump its own link, or the lane under it; a public bump the lane within 5 m", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdbumps-"));
  // A road running north at 127.0, and one running east at 37.51.
  const north: [number, number][] = [[127, 37.49], [127, 37.5], [127, 37.51]];
  const east: [number, number][] = [[126.99, 37.51], [127.01, 37.51]];
  writeFileSync(join(dir, "bumps.geojsons"), [
    bumpAt("own", 127.00001, 37.5, "LN"),               // on its own link, 1 m off its line
    bumpAt("far-link", 127.00002, 37.505, "LE"),        // its link 550 m away (a link of another place): the lane under it
    bumpAt("no-link", 127.003, 37.51),                  // 2024's: no link; the east road under it
    bumpAt("off-map", 127.05, 37.5),                    // no lane near: its way not known
  ].join("\n") + "\n");
  const hd = new HdPoints(dir);
  await hd.refresh();
  assert.ok(hd.features.every((f) => f.lane?.deg === -1), "no lanes.db yet: every bump strict, its way not known");
  lanesDb(join(dir, "lanes.db"), [{ id: "LN", coords: north }, { id: "LE", coords: east }]);
  assert.equal(await hd.refresh(), true, "the lanes came: read again");
  const lane = (id: string) => hd.features.find((f) => f.id === `hd:bump:${id}`)!.lane!;
  assert.equal(lane("own").deg, 0);
  assert.equal(lane("far-link").deg, 0);
  assert.equal(lane("no-link").deg, 90);
  assert.equal(lane("off-map").deg, -1);
  assert.deepEqual(lane("own").at, [hd.features[0].lon, hd.features[0].lat], "an HD bump's place is its own");

  const pub = [
    { id: "p-near", kind: "bump" as const, lon: 127.00004, lat: 37.495 },    // 3.5 m off the north road
    { id: "p-far", kind: "bump" as const, lon: 127.0002, lat: 37.495 },      // 18 m off: a street the map has not
    { id: "p-light", kind: "signal-light" as const, lon: 127.00004, lat: 37.495 },
  ];
  const kept = hd.without(pub);
  await hd.lanesSettled();
  const near = kept.find((f) => f.id === "p-near")!;
  assert.equal(near.lane?.deg, 0);
  assert.deepEqual(near.lane?.at, [127, 37.495], "put on the lane");
  assert.equal(kept.find((f) => f.id === "p-far")!.lane, undefined);
  assert.equal(kept.find((f) => f.id === "p-light")!.lane, undefined);
  // Asked again (the index rebuilt): known at once.
  assert.equal(hd.without(pub).find((f) => f.id === "p-near")!.lane?.deg, 0);
});
