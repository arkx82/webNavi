import { test } from "node:test";
import assert from "node:assert/strict";
import { cornersUnsaid, sayMissedTurns, sideOf } from "./missed.js";
import type { LonLat, Route } from "./types.js";

// 카카오's route out of 노원로22길 (2026-10-03): its line turns left onto 한글비석로5길 370 m in, and no guide says so.
const PATH: LonLat[] = [[127.073358, 37.646964], [127.073505, 37.64701], [127.073505, 37.64701], [127.07381, 37.647075], [127.07381, 37.647075], [127.07423, 37.647051], [127.07423, 37.647051], [127.074223, 37.646673], [127.074223, 37.646673], [127.074205, 37.646339], [127.074228, 37.646277], [127.074228, 37.646277], [127.074634, 37.645487], [127.074634, 37.645487], [127.074763, 37.645173], [127.074763, 37.645173], [127.075007, 37.644643], [127.075042, 37.644598], [127.075088, 37.644553], [127.075088, 37.644553], [127.075134, 37.644527], [127.075168, 37.644509], [127.075723, 37.644477], [127.075723, 37.644477], [127.076449, 37.644438], [127.076449, 37.644438], [127.076371, 37.6425], [127.076371, 37.6425], [127.076309, 37.64113], [127.076309, 37.64113]];
const kakao = (): Route => ({
  provider: "kakao", distanceM: 900, durationS: 200, path: PATH.map((p) => [...p] as LonLat), segments: [],
  guides: [
    { at: [127.073358, 37.646964], text: "출발지", distanceM: 0, turnType: 100 },
    { at: [127.07423, 37.647051], text: "우회전", distanceM: 79, turnType: 2 },
    { at: [127.076449, 37.644438], text: "대진고교 하계역 방면으로 우회전", distanceM: 413, turnType: 2 },
  ],
});

/** OSRM across the corner, as it answered there: "continue left" onto 한글비석로5길 — or, [bend], no manoeuvre at all. */
function stubOsrm(bend = false) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const [from, to] = /driving\/([^?]+)/.exec(String(url))![1].split(";").map((p) => p.split(",").map(Number) as LonLat);
    const corner: LonLat = [127.075088, 37.644553];
    const steps = [
      { name: "한글비석로5길", maneuver: { location: from, type: "depart" } },
      ...(bend ? [] : [{ name: "한글비석로5길", maneuver: { location: corner, type: "continue", modifier: "left" } }]),
      { name: "한글비석로5길", maneuver: { location: to, type: "arrive", modifier: "left" } },
    ];
    return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 80, geometry: { coordinates: [from, corner, to] }, legs: [{ steps }] }] }));
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

test("a corner of the line with no guide at it is found, and its side", () => {
  const corners = cornersUnsaid(kakao());
  assert.equal(corners.length, 1);
  assert.ok(Math.abs(corners[0].m - 372) < 15, `at ${corners[0].m} m`);
  assert.ok(corners[0].deg < -45, `${corners[0].deg}°`);
});

test("the turn OSRM makes there is put in among the guides, in order", async () => {
  const restore = stubOsrm();
  try {
    const r = kakao();
    assert.equal(await sayMissedTurns(r, "http://osrm"), 1);
    assert.deepEqual(r.guides.map((g) => g.text), ["출발지", "우회전", "한글비석로5길 방면 좌회전", "대진고교 하계역 방면으로 우회전"]);
    assert.equal(r.guides[2].turnType, "missed:continue/left");
  } finally {
    restore();
  }
});

test("where OSRM only follows the road round (a bend, not a junction), nothing is put in", async () => {
  const restore = stubOsrm(true);
  try {
    const r = kakao();
    assert.equal(await sayMissedTurns(r, "http://osrm"), 0);
    assert.equal(r.guides.length, 3);
  } finally {
    restore();
  }
});

test("a guide's side, from its words", () => {
  assert.equal(sideOf("공용터미널 방면으로 우회전"), 1);
  assert.equal(sideOf("왼쪽 방향"), -1);
  assert.equal(sideOf("올림픽파크 교차로에서 12시 방향"), 0);
  assert.equal(sideOf("회전교차로에서 오른쪽 3시 방향"), 1);
  assert.equal(sideOf("10시 방향"), -1);
  assert.equal(sideOf("직진"), 0);
});
