import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ColourGuides, facilityKey, junctionKey, parseGuides } from "./color-guides.js";
import { SeoulLines, tmToLonLat } from "./seoul-lines.js";
import type { LonLat } from "../route/types.js";

test("the 2025 list's facility without its kind (\"강일\", 비고 나들목) is found by the route's \"강일IC\"; a 졸음쉼터 is not a junction", async () => {
  assert.equal(facilityKey("강일", "나들목"), junctionKey("강일IC"));
  assert.equal(facilityKey("남구리", "국도접속부"), junctionKey("남구리IC"));
  assert.equal(facilityKey("서하남", "분기점"), junctionKey("서하남JC"));
  assert.equal(facilityKey("부평 나들목", "나들목"), junctionKey("부평IC"));
  assert.notEqual(facilityKey("구리", "졸음쉼터"), junctionKey("구리IC"));
  const csv = "구분,노선명,시설물 명칭,방향,분기형태,좌,우,비고\n143,서울외곽선,강일,퇴계원,1점2분기,녹색,분홍색,나들목\n144,서울외곽선,강일,판교,2점2분기,녹색,분홍색,나들목\n";
  assert.equal(parseGuides(csv).length, 2);
  const dir = mkdtempSync(join(tmpdir(), "cg-"));
  writeFileSync(join(dir, "color-guides.csv"), csv);
  const guides = new ColourGuides(dir, async () => null);
  const got = await guides.at("강일IC", [127.17, 37.56], 0, ["서울외곽순환"]);
  assert.deepEqual([got?.left, got?.right], ["green", "pink"]);
});

test("서울시's X/Y (EPSG:5186) to lon/lat: the origin, and a 서초구 point as pyproj-free math gives it", () => {
  const [lon0, lat0] = tmToLonLat(200000, 600000);
  assert.ok(Math.abs(lon0 - 127) < 1e-9 && Math.abs(lat0 - 38) < 1e-9);
  const [lon, lat] = tmToLonLat(198875.75, 540893.5312);
  assert.ok(Math.abs(lon - 126.987291) < 1e-6 && Math.abs(lat - 37.467468) < 1e-6, `${lon},${lat}`);
});

test("a line 서울시 lists on the route's way: right is pink; left is green beside another going right, else a line of no named colour", () => {
  // A road north along x = 0 (metres east/north of a point in 서울), parting at y = 100.
  const O: LonLat = [127.0, 37.5];
  const at = (x: number, y: number): LonLat => [O[0] + x / (111_320 * Math.cos((O[1] * Math.PI) / 180)), O[1] + y / 111_320];
  const toFile = (pts: [number, number][]) => {
    // Back to EPSG:5186 by inverting numerically, near enough: points given straight as lon/lat via a tiny search.
    const rows = pts.map(([x, y], i) => {
      const target = at(x, y);
      let X = 200000 + (target[0] - 127) * 88_000, Y = 600000 + (target[1] - 38) * 111_000;
      for (let k = 0; k < 20; k++) { const [lo, la] = tmToLonLat(X, Y); X += (target[0] - lo) * 88_000; Y += (target[1] - la) * 111_000; }
      return `${i + 1},중구,시도,주행유도선,${X},${Y}`;
    });
    const dir = mkdtempSync(join(tmpdir(), "sl-"));
    writeFileSync(join(dir, "seoul-color-lines.csv"), `연번,자치구,도로구분,구분,X좌표,Y좌표\n${rows.join("\n")}\n`);
    return new SeoulLines(dir);
  };
  const path = Array.from({ length: 19 }, (_, k) => at(0, k * 10));
  // One line on the route's lane at y = 80.
  const lone = toFile([[0.5, 80]]);
  assert.equal(lone.count, 1);
  assert.equal(lone.lineFor(at(0, 100), path, "right"), "pink");
  assert.equal(lone.lineFor(at(0, 100), path, "left"), "line");
  // And another 7 m to its right: two branches, the route the left one.
  const pair = toFile([[0.5, 80], [7, 82]]);
  assert.equal(pair.lineFor(at(0, 100), path, "left"), "green");
  // Only beside the route, not on it: none.
  const off = toFile([[12, 80]]);
  assert.equal(off.lineFor(at(0, 100), path, "right"), null);
});
