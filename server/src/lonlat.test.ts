import { test } from "node:test";
import assert from "node:assert/strict";
import { ROUTE_MAX_M, inKorea, pathM } from "./lonlat.js";

test("a page's points are Korea's, and a path no longer than a drive: the date line and 1e300 are refused", () => {
  for (const p of [[126.978, 37.566], [126.27, 33.12], [124.71, 37.97], [131.87, 37.24]]) assert.ok(inKorea(p), String(p));
  for (const p of [[-179, 0], [179, 0.1], [1e300, 37], [Number.NaN, 37], [127, Infinity], ["127", 37], [127], null]) assert.ok(!inKorea(p), String(p));
  // 서울 → 부산 straight is about 325 km; the four points across the date line would have been 100 000 km.
  const seoulBusan: [number, number][] = [[126.978, 37.566], [129.075, 35.18]];
  assert.ok(Math.abs(pathM(seoulBusan) - 325_000) < 10_000, `${pathM(seoulBusan)}`);
  const zigzag: [number, number][] = Array.from({ length: 20 }, (_, i) => (i % 2 ? [129.5, 35] : [124.5, 38]) as [number, number]);
  assert.ok(pathM(zigzag) > ROUTE_MAX_M);
});
