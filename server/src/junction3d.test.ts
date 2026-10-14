import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Junction3D, lift, type P3 } from "./junction3d.js";

const O: [number, number] = [127.13, 37.476];
const M = 111_320;
/** Metres east, north and up of O as [lon, lat, h]. */
const ll = (x: number, y: number, h: number) => [O[0] + x / (M * Math.cos((O[1] * Math.PI) / 180)), O[1] + y / M, h];

function store(rows: { kind: number; yr: number; t?: string; pts: number[][] }[]) {
  const dir = mkdtempSync(join(tmpdir(), "j3d-"));
  const db = new DatabaseSync(join(dir, "j3d.db"));
  db.exec("CREATE TABLE f (id INTEGER PRIMARY KEY, kind INTEGER, yr INTEGER, t TEXT, k TEXT, xyz TEXT); CREATE VIRTUAL TABLE box USING rtree(id, minx, maxx, miny, maxy)");
  rows.forEach((r, i) => {
    db.prepare("INSERT INTO f VALUES (?, ?, ?, ?, ?, ?)").run(i + 1, r.kind, r.yr, r.t ?? "", "", JSON.stringify(r.pts));
    const xs = r.pts.map((p) => p[0]), ys = r.pts.map((p) => p[1]);
    db.prepare("INSERT INTO box VALUES (?, ?, ?, ?, ?)").run(i + 1, Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys));
  });
  db.close();
  return new Junction3D(join(dir, "j3d.db"));
}

test("the junction round a point: the older of two surveys on one lane let go, a long link cut to the square, metres about the point", () => {
  const j = store([
    { kind: 0, yr: 19, pts: [ll(0, -2000, 50), ll(0, 0, 50), ll(0, 2000, 50)] },
    { kind: 0, yr: 25, pts: [ll(0.5, -2000, 50.3), ll(0.5, 0, 50.3), ll(0.5, 2000, 50.3)] },
    { kind: 1, yr: 25, t: "212", pts: [ll(2, -100, 50), ll(2, 100, 50)] },
  ]);
  const s = j.scene(O, 300)!;
  assert.equal(s.links.length, 1, "the 2019 survey under the 2025 one is dropped");
  assert.ok(s.links[0].every((p) => Math.abs(p[2]) <= 330), "cut to the square");
  assert.ok(Math.abs(s.links[0][0][1] - 50.3) < 0.01, "heights kept");
  assert.equal(s.lines[0].t, "212");
  // x east, z south: a point 100 m north is z -100.
  const end = s.lines[0].pts[s.lines[0].pts.length - 1];
  assert.ok(Math.abs(end[2] + 100) < 0.2, `${end}`);
});

test("the route lifted onto its lanes: under a bridge it stays on the road below, up a ramp it climbs with it", () => {
  // A road north at 50 m; a bridge across it east–west at 62 m (another way, not taken); a ramp beside going up to 60.
  const road: P3[] = Array.from({ length: 41 }, (_, i) => [0, 50, 200 - i * 10]);
  const bridge: P3[] = Array.from({ length: 21 }, (_, i) => [-100 + i * 10, 62, 0]);
  const ramp: P3[] = Array.from({ length: 21 }, (_, i) => [3.5, 50 + i * 0.5, 200 - i * 10]);
  const under = lift(road.map(([x, , z]) => [x, 0, z] as P3), [road, bridge, ramp]).points;
  assert.ok(under.every((p) => p && Math.abs(p[1] - 50) < 0.6), "on the road below the whole way");
  const up = lift(ramp.map(([x, , z]) => [x + 0.5, 0, z] as P3), [road, ramp]).points;
  assert.ok(Math.abs(up[up.length - 1]![1] - 60) < 0.6, `up the ramp: ${up[up.length - 1]![1]}`);
});
