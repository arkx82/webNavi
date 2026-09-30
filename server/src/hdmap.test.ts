import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { HdTiles, registerHdmap, TILE_CACHE_CONTROL } from "./hdmap.js";

/** An mbtiles with one tile (z16 x1 y2 from the north: TMS row 65533) and the bounds [meta] says. */
function mbtiles(file: string, bounds: string, tile: string) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)");
  const meta = db.prepare("INSERT INTO metadata VALUES (?, ?)");
  meta.run("bounds", bounds);
  meta.run("minzoom", "15");
  meta.run("maxzoom", "18");
  meta.run("attribution", "test");
  db.prepare("INSERT INTO tiles VALUES (?, ?, ?, ?)").run(16, 1, (1 << 16) - 1 - 2, Buffer.from(tile));
  db.close();
}

test("tiles come from the mbtiles by the map's row, and the file is opened again when replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "hdmap-"));
  const file = join(dir, "hdmap.mbtiles");
  const tiles = new HdTiles(file, 0);
  assert.equal(tiles.ready, false);
  assert.equal(tiles.info(), null);
  mbtiles(file, "126.7,37.4,127.2,37.7", "one");
  assert.ok(tiles.ready);
  assert.deepEqual(tiles.info(), { bounds: [126.7, 37.4, 127.2, 37.7], minzoom: 15, maxzoom: 18, attribution: "test" });
  assert.equal(tiles.tile(16, 1, 2)?.toString(), "one");
  assert.equal(tiles.tile(16, 1, 3), null);
  // A rebuild: a new file moved into place, with a later time.
  mbtiles(join(dir, "hdmap.mbtiles.new"), "126.7,37.4,127.2,37.7", "two");
  const later = new Date(Date.now() + 5000);
  utimesSync(join(dir, "hdmap.mbtiles.new"), later, later);
  renameSync(join(dir, "hdmap.mbtiles.new"), file);
  assert.equal(tiles.tile(16, 1, 2)?.toString(), "two");
});

test("the file's time is looked at only every so often, not on every tile", () => {
  const dir = mkdtempSync(join(tmpdir(), "hdmap-"));
  const file = join(dir, "hdmap.mbtiles");
  mbtiles(file, "126.7,37.4,127.2,37.7", "one");
  const tiles = new HdTiles(file, 60_000);
  assert.equal(tiles.tile(16, 1, 2)?.toString(), "one");
  mbtiles(join(dir, "hdmap.mbtiles.new"), "126.7,37.4,127.2,37.7", "two");
  const later = new Date(Date.now() + 5000);
  utimesSync(join(dir, "hdmap.mbtiles.new"), later, later);
  renameSync(join(dir, "hdmap.mbtiles.new"), file);
  // Within the minute: still the file as opened (the statement kept with it).
  assert.equal(tiles.tile(16, 1, 2)?.toString(), "one");
});

test("an empty tile is a 204 kept as long as a full one; the info gives the bounds", async () => {
  const work = mkdtempSync(join(tmpdir(), "hdmap-work-"));
  mkdirSync(join(work, "hdmap"));
  mbtiles(join(work, "hdmap", "hdmap.mbtiles"), "126.7,37.4,127.2,37.7", "one");
  const app = Fastify();
  registerHdmap(app, work);
  const full = await app.inject({ url: "/api/hdmap/tiles/16/1/2.pbf" });
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers["cache-control"], TILE_CACHE_CONTROL);
  assert.equal(full.body, "one");
  const empty = await app.inject({ url: "/api/hdmap/tiles/16/1/3.pbf" });
  assert.equal(empty.statusCode, 204);
  assert.equal(empty.headers["cache-control"], TILE_CACHE_CONTROL, "the browser keeps the empty tile too");
  const info = await app.inject({ url: "/api/hdmap/info" });
  assert.deepEqual(info.json().bounds, [126.7, 37.4, 127.2, 37.7]);
  assert.equal((await app.inject({ url: "/api/hdmap/tiles/x/1/3.pbf" })).statusCode, 400);
  await app.close();
});
