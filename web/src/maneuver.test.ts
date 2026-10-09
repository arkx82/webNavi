import { test } from "node:test";
import assert from "node:assert/strict";
import { fromBend, maneuverOf } from "./maneuver";
import type { Provider } from "./types";

const m = (provider: Provider, turnType: number, text: string) => maneuverOf(provider, { at: [0, 0], text, distanceM: 0, turnType });

// Pairs from real answers (2026-09-30); the old tables made several of these a U-turn or the wrong side.
test("Kakao's codes and words: 왼쪽/오른쪽 방향, clock hours, motorway exits", () => {
  assert.equal(m("kakao", 5, "원주 방면으로 왼쪽 방향"), "slight-left");
  assert.equal(m("kakao", 6, "용인 평택 방면으로 오른쪽 방향"), "slight-right");
  assert.equal(m("kakao", 9, "용인 방면으로 오른쪽에 고속도로 출구"), "ramp-right");
  assert.equal(m("kakao", 29, "12시 방향"), "straight");
  assert.equal(m("kakao", 27, "왼쪽 10시 방향"), "slight-left");
  assert.equal(m("kakao", 21, "오른쪽 4시 방향"), "sharp-right");
  assert.equal(m("kakao", 84, "톨게이트 진입"), "other");
  assert.equal(m("kakao", 49, "인천 원주 방면으로 오른쪽 고속도로 진입"), "slight-right");
  assert.equal(m("kakao", 1, "좌회전"), "left");
  // 2026-10-09, 동부간선로's end at 장암: 42 is Kakao's right ("…방면으로 오른쪽 도로 주행"), said bare as an exit.
  assert.equal(m("kakao", 42, "도시고속도로 출구"), "ramp-right");
  assert.equal(m("kakao", 42, "덕소삼패IC에서 '서울양양고속도로, 춘천, 화도' 방면으로 오른쪽 도로 주행"), "slight-right");
  assert.equal(m("kakao", 41, "춘천분기점에서 '중앙고속도로, 춘천' 방면으로 왼쪽 도로 주행"), "slight-left");
});

test("NAVER's: 4 and 5 are 왼쪽 and 오른쪽 방향, 6 the U-turn", () => {
  assert.equal(m("naver", 5, "신갈분기점에서 '원주, 인천' 방면으로 오른쪽 방향"), "slight-right");
  assert.equal(m("naver", 4, "왼쪽 방향"), "slight-left");
  assert.equal(m("naver", 6, "송파구청에서 유턴"), "uturn");
  assert.equal(m("naver", 67, "용인IC에서 '용인' 방면으로 오른쪽 고속도로 출구"), "ramp-right");
  assert.equal(m("naver", 60, "왼쪽 도시고속도로 출구"), "ramp-left");
  assert.equal(m("naver", 121, "용인톨게이트 (통행료 2,200원)"), "other");
});

test("TMAP's: the words over the rest of the sentence, the code where the words say no side", () => {
  assert.equal(m("tmap", 117, "신갈JC에서 인천 방면으로 오른쪽 방향 후 영동 고속도로를 따라 121m 이동"), "slight-right");
  assert.equal(m("tmap", 104, "용인IC에서 용인 방면으로 오른쪽 고속도로 출구 후 영동 고속도로를 따라 1025m 이동"), "ramp-right");
  assert.equal(m("tmap", 17, "10시 방향 좌회전"), "slight-left");
  assert.equal(m("tmap", 103, "장수IC에서 전방 고속도로 입구"), "straight");
  assert.equal(m("tmap", 119, "창동 지하차도에서 지하차도"), "other");
});

test("a guide with no way in its words gets one from the road's bend", () => {
  assert.equal(fromBend(10, 40, true), "ramp-right");
  assert.equal(fromBend(10, 350, true), "ramp-left");
  assert.equal(fromBend(350, 4, false), null);
  assert.equal(fromBend(0, 90, false), "right");
  assert.equal(fromBend(90, 50, false), "slight-left");
  assert.equal(fromBend(0, 180, false), "uturn");
});

test("a lane named beside the way does not become the way: the side bound to 방향/출구 wins, else the last said", async () => {
  const { fromText } = await import("./maneuver.js");
  assert.equal(fromText("좌측 차로를 이용하여 오른쪽 방향"), "slight-right");
  assert.equal(fromText("우측 2차로 이용, 왼쪽 고속도로 출구"), "ramp-left");
  assert.equal(fromText("오른쪽 방향으로 진행, 왼쪽 차로 주의"), "slight-right");
  assert.equal(fromText("왼쪽 차로에서 오른쪽"), "slight-right");
  assert.equal(fromText("오른쪽 방향"), "slight-right");
});

test("the road's shape preserves explicit directions and recognizes loop ramps", async () => {
  const { shapedOf } = await import("./maneuver.js");
  // 성수대교 onto 강변북로: the words say 오른쪽 방향, the road curls 270° right.
  assert.equal(shapedOf("slight-right", { d60: 40, sweep200: 270 }), "loop-right");
  assert.equal(shapedOf("other", { d60: -30, sweep200: -250 }), "loop-left");
  // Explicit directions are preserved and never inverted by road curvature
  assert.equal(shapedOf("slight-right", { d60: -40, sweep200: -45 }), "slight-right");
  assert.equal(shapedOf("ramp-right", { d60: -40, sweep200: -45 }), "ramp-right");
  // A fork that parts slowly, or bends the named way: the words stand.
  assert.equal(shapedOf("slight-right", { d60: 8, sweep200: 12 }), "slight-right");
  assert.equal(shapedOf("slight-right", { d60: -10, sweep200: -12 }), "slight-right");
  assert.equal(shapedOf("left", { d60: -80, sweep200: -90 }), "left");
  // No shape known, or a manoeuvre that is what it is.
  assert.equal(shapedOf("slight-right", null), "slight-right");
  assert.equal(shapedOf("uturn", { d60: 170, sweep200: 180 }), "uturn");
  assert.equal(shapedOf("arrive", { d60: 0, sweep200: 300 }), "arrive");
});
