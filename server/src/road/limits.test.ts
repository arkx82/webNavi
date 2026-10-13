import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SpeedLimits, resample, type Fetch, type LonLat } from "./limits.js";

/** A straight road east, 1 km: 11 samples. */
const PATH: LonLat[] = [[127.0, 37.5], [127.0113, 37.5]];

function tmapAnswering(speedOf: (p: LonLat, i: number) => number | null, shift: (i: number) => number = () => 0) {
  const calls: string[] = [];
  const fetchJson: Fetch = async (url, init) => {
    calls.push(url);
    if (url.includes("matchToRoads")) {
      const coords = decodeURIComponent(init!.body!.split("coords=")[1]).split("|").map((c) => c.split(",").map(Number) as LonLat);
      const matchedPoints = coords.map((p, i) => ({ sourceIndex: i, speed: speedOf(p, i), matchedLocation: { longitude: p[0], latitude: p[1] + shift(i) } }));
      return { status: 200, json: async () => ({ resultData: { matchedPoints } }) };
    }
    return { status: 404, json: async () => ({}) };
  };
  return { calls, fetchJson };
}

test("the route's limits are TMAP's, as runs of path positions, and asked once a day for one place", async () => {
  const t = tmapAnswering((p) => (p[0] < 127.0056 ? 50 : 60));
  const limits = new SpeedLimits(() => "key", () => undefined, "/nowhere/links.db", undefined, t.fetchJson);
  const a = await limits.alongRoute(PATH);
  assert.equal(a.tmapShare, 1);
  assert.deepEqual(a.runs.map((r) => r.kmh), [50, 60]);
  assert.equal(a.runs[0].from, 0);
  assert.ok(Math.abs(a.runs[1].to - 1) < 1e-9, "to the path's end");
  assert.ok(Math.abs(a.runs[0].to - a.runs[1].from) < 1e-9, "no gap between runs");
  assert.ok(a.runs[0].to > 0.4 && a.runs[0].to < 0.6, `the change near halfway, at ${a.runs[0].to}`);
  assert.equal(t.calls.length, 1);
  // Again (a re-route, the lane line): from what was said today, no call.
  const again = await limits.alongRoute([[127.0, 37.50001], [127.0113, 37.50001]]);
  assert.deepEqual(again.runs.map((r) => r.kmh), [50, 60]);
  assert.equal(t.calls.length, 1);
});

test("a point TMAP put on another road is not taken, and with no 노드링크 that stretch has no limit", async () => {
  const t = tmapAnswering(() => 50, (i) => (i === 5 ? 0.001 : 0)); // ~110 m off
  const limits = new SpeedLimits(() => "key", () => undefined, "/nowhere/links.db", undefined, t.fetchJson);
  const a = await limits.alongRoute(PATH);
  assert.equal(a.runs.length, 2, "split round the point matched elsewhere");
  assert.ok(a.tmapShare < 1);
});

test("TMAP's limit reached (429): no more calls that day", async () => {
  let n = 0;
  const fetchJson: Fetch = async () => { n++; return { status: 429, json: async () => ({ error: { code: "QUOTA_EXCEEDED" } }) }; };
  const limits = new SpeedLimits(() => "key", () => undefined, "/nowhere/links.db", undefined, fetchJson);
  await limits.alongRoute(PATH);
  await limits.alongRoute([[128, 36], [128.02, 36]]);
  assert.equal(n, 1);
  assert.equal(limits.status().tmapCallsToday, limits.status().budget);
});

test("표준노드링크 where TMAP has nothing: the route's nodes read as links end to end, an inner vertex found by its block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limits-"));
  const db = new DatabaseSync(join(dir, "links.db"));
  db.exec("CREATE TABLE links (id TEXT PRIMARY KEY, f TEXT, t TEXT, maxspd INTEGER, nodes TEXT); CREATE INDEX links_ft ON links (f, t)");
  const put = db.prepare("INSERT INTO links VALUES (?, ?, ?, ?, ?)");
  put.run("L1", "1", "2", 80, "1,9000000001,9000000002,2");
  put.run("L2", "2", "3", 60, "2,3");
  db.close();
  const fetchJson: Fetch = async (url) => {
    if (url.includes("/route/v1/") && !url.includes("radiuses=25;60")) {
      // Two legs: 1 → 9000000001 → 9000000002 → 2 | 2 → 3.
      return { status: 200, json: async () => ({ code: "Ok", routes: [{ legs: [
        { annotation: { nodes: [1, 9000000001, 9000000002, 2], distance: [100, 200, 200] } },
        { annotation: { nodes: [2, 3], distance: [500] } },
      ] }] }) };
    }
    if (url.includes("/route/v1/") && url.includes("radiuses=25;60")) {
      // The car's few tens of metres on: from inside L1.
      return { status: 200, json: async () => ({ code: "Ok", waypoints: [{ distance: 3 }, { distance: 10 }], routes: [{ legs: [{ annotation: { nodes: [9000000001, 9000000002] } }] }] }) };
    }
    return { status: 404, json: async () => ({}) };
  };
  const limits = new SpeedLimits(() => undefined, () => "http://osrm", join(dir, "links.db"), undefined, fetchJson);
  // Three waypoints 500 m apart: a path of 1 km, the first half on L1, the second on L2.
  const path: LonLat[] = [[127.0, 37.5], [127.0113, 37.5]];
  const s = resample(path);
  assert.equal(s.length, 11);
  const a = await limits.alongRoute(path);
  assert.equal(a.tmapShare, 0);
  assert.deepEqual(a.runs.map((r) => [r.kmh, r.src]), [[80, "nodelink"], [60, "nodelink"]]);
  // Off any route: the inner vertex's link.
  const h = await limits.here("june", [127.001, 37.5], 90);
  assert.deepEqual(h, { kmh: 80, src: "nodelink" }, JSON.stringify(limits.status()));
});

test("off the route: TMAP's nearest road if it runs the car's way, remembered along its length", async () => {
  let n = 0;
  const road = [[127.0, 37.5], [127.002, 37.5]]; // east–west
  const fetchJson: Fetch = async (url) => {
    n++;
    if (url.includes("nearToRoad")) {
      return { status: 200, json: async () => ({ resultData: { header: { speed: 70 }, linkPoints: road.map(([x, y]) => ({ location: { longitude: x, latitude: y } })) } }) };
    }
    return { status: 404, json: async () => ({}) };
  };
  let now = 1_800_000_000_000;
  const limits = new SpeedLimits(() => "key", () => undefined, "/nowhere/links.db", undefined, fetchJson, () => now);
  // Running north across it: the road over or under, not this one.
  assert.deepEqual(await limits.here("june", [127.001, 37.50002], 0), { kmh: null, src: null });
  now += 11_000;
  assert.deepEqual(await limits.here("june", [127.001, 37.50002], 92), { kmh: 70, src: "tmap" });
  // Further along the same link: remembered, not asked.
  const before = n;
  assert.deepEqual(await limits.here("june", [127.0015, 37.5], 270), { kmh: 70, src: "tmap" });
  assert.equal(n, before);
  // A day on: let go (TMAP's terms), asked again.
  now += 24 * 3_600_000;
  await limits.here("june", [127.0015, 37.5], 90);
  assert.equal(n, before + 1);
});

test("a waypoint OSRM cannot place (a lane 표준노드링크 lacks) is left out, not the whole stretch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limits-"));
  const db = new DatabaseSync(join(dir, "links.db"));
  db.exec("CREATE TABLE links (id TEXT PRIMARY KEY, f TEXT, t TEXT, maxspd INTEGER, nodes TEXT); CREATE INDEX links_ft ON links (f, t)");
  db.prepare("INSERT INTO links VALUES (?, ?, ?, ?, ?)").run("L", "1", "2", 70, "1,2");
  db.close();
  const asked: number[] = [];
  const fetchJson: Fetch = async (url) => {
    const n = url.split("/driving/")[1].split("?")[0].split(";").length;
    asked.push(n);
    if (n === 3) return { status: 400, json: async () => ({ code: "NoSegment", message: "Could not find a matching segment for coordinate 0" }) };
    return { status: 200, json: async () => ({ code: "Ok", routes: [{ legs: [{ annotation: { nodes: [1, 2], distance: [500] } }] }] }) };
  };
  const limits = new SpeedLimits(() => undefined, () => "http://osrm", join(dir, "links.db"), undefined, fetchJson);
  const a = await limits.alongRoute([[127.0, 37.5], [127.0113, 37.5]]);
  assert.deepEqual(asked, [3, 2]);
  assert.ok(a.runs.some((r) => r.kmh === 70 && r.src === "nodelink"));
});
