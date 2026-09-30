import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ACTIVE_MS, CYCLE_MS, FRESH_MS, LinkBook, Traffic, boxOf, cellOf, cellsAlong } from "./traffic.js";
import { congestionOf } from "../route/osrm.js";

function linksDb(dir: string) {
  const db = new DatabaseSync(join(dir, "links.db"));
  db.exec("CREATE TABLE links (id TEXT PRIMARY KEY, f TEXT, t TEXT, maxspd INTEGER, nodes TEXT)");
  const ins = db.prepare("INSERT INTO links VALUES (?, ?, ?, ?, ?)");
  ins.run("1000000100", "1000000001", "1000000002", 60, "1000000001,100000000001,100000000002,1000000002");
  ins.run("1000000200", "1000000002", "1000000003", 80, "1000000002,1000000003");
  db.close();
}

test("cells: a route from 강남 to 부산 wants the cells along it, none outside Korea", () => {
  assert.equal(cellOf([127.0276, 37.4979]), "127,37");
  assert.equal(cellOf([139.7, 35.7]), null);
  const cells = cellsAlong([[127.0276, 37.4979], [129.0756, 35.1796]]);
  assert.ok(cells.has("127,37") && cells.has("129,35"));
  assert.ok(cells.has("128,36"), [...cells].join(" "));
  assert.ok(cells.size >= 4 && cells.size <= 7, [...cells].join(" "));
  assert.deepEqual(boxOf("128,36"), { minX: 128, minY: 36, maxX: 129, maxY: 37 });
});

test("in use, the cells round the route are fetched every five minutes and speeds.csv names every segment of every link heard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "traffic-"));
  linksDb(dir);
  let clock = 1_000_000;
  const asked: string[] = [];
  const traffic = new Traffic(() => "key", dir, () => {}, async (url) => {
    asked.push(new URL(url).searchParams.get("minX")!);
    return { body: { items: [{ linkId: "1000000100", speed: "24" }, { linkId: "1000000200", speed: "0" }, { linkId: "9999999999", speed: "50" }] } };
  }, () => clock);
  assert.ok(traffic.ready);
  assert.ok(!traffic.active);
  traffic.touch([[127.05, 37.5]]);
  assert.ok(traffic.active);
  await traffic.cycle();
  assert.deepEqual(asked, ["127"]);
  const csv = readFileSync(join(dir, "speeds.csv"), "utf8");
  // Three segments of the first link at 24 km/h; a speed of 0 is not a speed; an unknown link has no segments.
  assert.equal(csv, "1000000001,100000000001,24\n100000000001,100000000002,24\n100000000002,1000000002,24\n");
  assert.equal(traffic.status().callsToday, 1);
  // A quarter of an hour on with no one asking: the router is idle, and the stale speed goes.
  clock += FRESH_MS + 1;
  assert.ok(!traffic.active);
  await traffic.cycle();
  assert.deepEqual(asked, ["127"]);
  assert.equal(traffic.writeSpeeds().links, 0);
  assert.equal(readFileSync(join(dir, "speeds.csv"), "utf8"), "");
  assert.ok(ACTIVE_MS < FRESH_MS && CYCLE_MS < ACTIVE_MS);
});

test("a link is found by the nodes it joins, and a route's congestion comes from the live segments against the limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "links-"));
  linksDb(dir);
  const book = new LinkBook(join(dir, "links.db"));
  assert.deepEqual(book.between(1000000001, 1000000002), { id: "1000000100", maxspd: 60 });
  assert.equal(book.between(1000000002, 1000000001), null);
  assert.deepEqual(book.nodesOf("1000000200"), [1000000002, 1000000003]);
  const limit = (f: number, t: number) => book.between(f, t)?.maxspd ?? null;
  // Four segments over two links: the first link live at 4 m/s (14 km/h of 60: congested) then 9 m/s (32: slow), the second from the profile.
  const nodes = [1000000001, 100000000001, 100000000002, 1000000002, 1000000003];
  const segs = congestionOf(nodes, [4, 4, 9, 20], [1, 1, 1, 0], limit);
  assert.deepEqual(segs, [{ from: 0, to: 2, congestion: 3 }, { from: 2, to: 3, congestion: 2 }, { from: 3, to: 4, congestion: 0 }]);
});
