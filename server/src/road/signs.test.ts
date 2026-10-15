import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIGN_HOLD_M, overlaySigns, resample, type LimitSource } from "./limits.js";
import { SpeedSigns, kmhOf, type LonLat } from "./signs.js";

// A street laid out in metres about a point in Seoul, put into lon/lat.
const O: LonLat = [127.07, 37.6476];
const M = 111_320;
const at = (x: number, y: number): LonLat => [O[0] + x / (M * Math.cos((O[1] * Math.PI) / 180)), O[1] + y / M];

test("a sign's words: 최고속도제한 in its spellings; not 안전속도, 최저속도, nor odd numbers", () => {
  assert.equal(kmhOf("최고속도제한 50km"), 50);
  assert.equal(kmhOf("최고속도제한30km"), 30);
  assert.equal(kmhOf("최고속도제한 30km/h"), 30);
  assert.equal(kmhOf("최고속도 제한 60"), 60);
  assert.equal(kmhOf("최고속도60제한"), 60);
  assert.equal(kmhOf("60/최고속도"), 60);
  assert.equal(kmhOf("속도제한50"), 50);
  assert.equal(kmhOf("최고속도제한(50km)"), 50);
  assert.equal(kmhOf("최고속도제한_50"), 50);
  assert.equal(kmhOf("최고속도제한 30k"), 30);
  assert.equal(kmhOf("최고속도제한5"), null, "cut short: 50 or 5");
  assert.equal(kmhOf("최고속도제한"), null);
  assert.equal(kmhOf("속도를줄이시오"), null);
  assert.equal(kmhOf("안전속도40km"), null);
  assert.equal(kmhOf("최저속도제한 30km"), null);
  assert.equal(kmhOf("최고속도제한 55km"), null);
  assert.equal(kmhOf(null), null);
});

test("a sign is the route's where it stands by it and its lane runs the route's way beside it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "signs-"));
  const sign = (id: string, x: number, y: number, rem: string, link: string) =>
    JSON.stringify({ type: "Feature", properties: { id, rem, link }, geometry: { type: "Polygon", coordinates: [[at(x, y), at(x + 0.3, y), at(x, y + 0.3), at(x, y)]] } });
  writeFileSync(join(dir, "signs.geojsons"), [
    // East along y = 0: a 30 on the right at x 100 for the eastbound lane, its twin on the left; a 50 at x 600.
    sign("B1", 100, -6, "최고속도제한 30km", "EAST"),
    sign("B2", 105, 6, "최고속도제한 30km", "EAST"),
    sign("B3", 600, -6, "최고속도제한 50km", "EAST"),
    sign("B3b", 604, 6, "최고속도제한 50km", "EAST"),
    // A 30 alone (a lane's, a pocket's), and one written twice to the centimetre: no twin, not taken.
    sign("B7", 800, -6, "최고속도제한 30km", "EAST"),
    sign("B8", 850, -6, "최고속도제한 40km", "EAST"),
    sign("B8", 850, -6, "최고속도제한 40km", "EAST"),
    // The westbound lane's sign (the other way) and a side road's 20 m off: not the route's.
    sign("B4", 300, 8, "최고속도제한 60km", "WEST"),
    sign("B5", 400, -22, "최고속도제한 40km", "SIDE"),
    // 안전속도 under road works: not a limit.
    sign("B6", 450, -6, "안전속도40km", "EAST"),
  ].join("\n") + "\n");
  const lines: Record<string, LonLat[]> = {
    EAST: [at(-100, -1.5), at(1000, -1.5)],
    WEST: [at(1000, 1.5), at(-100, 1.5)],
    SIDE: [at(-100, -20), at(1000, -20)],
  };
  const signs = new SpeedSigns(join(dir, "signs.geojsons"), (id) => lines[id] ?? null);
  await signs.refresh();
  assert.equal(signs.size, 9, "the 안전속도 plate left out");
  const posted = signs.along([at(0, 0), at(500, 0), at(900, 0)]);
  assert.deepEqual(posted.map((p) => [Math.round(p.m), p.kmh]), [[100, 30], [600, 50]], "the twin as one; the other way's, the side road's and the lone ones not");
});

test("a sign's limit holds from it while the data says the one road, to the next sign, and puts the data right", () => {
  const path: LonLat[] = [at(0, 0), at(3000, 0)];
  const samples = resample(path);
  // The data: 60 to 1 km (an old limit), then 80 (another road).
  const kmh: (number | null)[] = samples.map((s) => (s.m < 1000 ? 60 : 80));
  const src: (LimitSource | null)[] = samples.map(() => "nodelink");
  overlaySigns(samples, kmh, src, [{ m: 200, kmh: 50 }]);
  const at_ = (m: number) => { const i = samples.findIndex((s) => s.m >= m); return [kmh[i], src[i]]; };
  assert.deepEqual(at_(100), [60, "nodelink"], "before the sign, the data");
  assert.deepEqual(at_(200), [50, "sign"]);
  assert.deepEqual(at_(900), [50, "sign"], "on the same road");
  assert.deepEqual(at_(1100), [80, "nodelink"], "another road: the data again");
  // Where the data had nothing the sign fills a little, not on and on.
  const none: (number | null)[] = samples.map(() => null);
  overlaySigns(samples, none, samples.map(() => null), [{ m: 0, kmh: 30 }]);
  assert.equal(none.filter((v) => v === 30).length, 6, "SIGN_FILL_M: 500 m of 100 m samples");
  // A long road: no further than SIGN_HOLD_M.
  const long = samples.map(() => 60 as number | null);
  overlaySigns(samples, long, samples.map(() => null), [{ m: 0, kmh: 50 }]);
  assert.ok(samples.filter((s, i) => long[i] === 50).every((s) => s.m <= SIGN_HOLD_M));
});
