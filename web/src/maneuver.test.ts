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
