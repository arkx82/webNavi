import { test } from "node:test";
import assert from "node:assert/strict";
import { behindCar, kakaoCameraStep, kakaoCardShown, otherWayCamera, otherWays, stillAway, type KakaoCamera } from "./kakao-camera";
import { offset } from "./geo";
import type { Feature } from "./warnings";
import type { LonLat } from "./types";

const car: LonLat = [126.43801, 34.93824];
const cam = (at: LonLat, ...degs: number[]): Feature => ({ id: `c${degs.join("-")}`, kind: "speed", lon: at[0], lat: at[1], limit: 80, ways: degs.map((deg) => ({ deg, at })) });

test("카카오's camera our lists have on the other carriageway is not this car's; one on ours, or at a junction, is", () => {
  // 청수가든앞 (G4699) on hantwo's way to 무안, 2026-11-12: the car heading 37°, the camera 518 m on, standing on the
  // carriageway the other way (209°).
  const told = offset(car, 37, 518);
  const g4699 = cam(offset(told, 120, 20), 209);
  assert.equal(otherWays(g4699, 37), true);
  assert.equal(otherWayCamera([g4699], told, 37)?.id, g4699.id);
  // The way home: the same camera is the car's.
  assert.equal(otherWayCamera([g4699], told, 209), null);
  // Two rows at one junction, one each way (구암삼거리 G2808 / G1828): the car's way is there.
  assert.equal(otherWayCamera([g4699, cam(told, 37)], told, 37), null);
  // On the cross street too: still the other way's, as the route's watch has it. With no carriageways known, or one
  // across alone: nothing said either way.
  assert.equal(otherWayCamera([cam(told, 209, 120)], told, 37)?.id, "c209-120");
  assert.equal(otherWayCamera([cam(told, 120)], told, 37), null);
  assert.equal(otherWayCamera([{ ...g4699, ways: undefined }], told, 37), null);
  // None of ours near it: 카카오's own, said.
  assert.equal(otherWayCamera([cam(offset(told, 0, 200), 209)], told, 37), null);
});

test("a camera behind the car is behind it; one beside it, or ahead, is not", () => {
  assert.equal(behindCar(car, 37, offset(car, 217, 400)), true);
  assert.equal(behindCar(car, 37, offset(car, 37, 400)), false);
  assert.equal(behindCar(car, 37, offset(car, 140, 400)), false);
  assert.equal(behindCar(car, 37, offset(car, 217, 50)), false);
});

test("카카오's camera on the card from 카메라 안내 시작 in, while the car comes to it; let go when it goes away never at it", () => {
  const t0 = 1_700_000_000_000;
  // Told at about a kilometre (카카오's Far): held, but not on the card until 600 m (hantwo: "600 m 인데 1 km 앞에서 뜸").
  const c: KakaoCamera = { since: t0, nearest: Infinity };
  assert.equal(kakaoCameraStep(c, 955, t0), "coming");
  assert.equal(kakaoCardShown("coming", 955, 600), false);
  assert.equal(kakaoCameraStep(c, 590, t0 + 20_000), "coming");
  assert.equal(kakaoCardShown("coming", 590, 600), true);
  // At it and past: off the card, the limit held to 300 m on.
  assert.equal(kakaoCameraStep(c, 20, t0 + 45_000), "coming");
  assert.equal(kakaoCameraStep(c, 120, t0 + 50_000), "passed");
  assert.equal(kakaoCardShown("passed", 120, 600), false);
  assert.equal(kakaoCameraStep(c, 320, t0 + 58_000), "done");

  // The other carriageway's, across a wide road from the car's: nearest 70 m, then the metres count up.
  const o: KakaoCamera = { since: t0, nearest: Infinity };
  for (const [d, s] of [[600, 0], [300, 15], [90, 26], [70, 28], [100, 30]] as const) assert.equal(kakaoCameraStep(o, d, t0 + s * 1000), "coming");
  assert.equal(kakaoCameraStep(o, 130, t0 + 32_000), "away");
  // On a road away from it from the first: let go 50 m on.
  const a: KakaoCamera = { since: t0, nearest: Infinity };
  assert.equal(kakaoCameraStep(a, 700, t0), "coming");
  assert.equal(kakaoCameraStep(a, 740, t0 + 2000), "coming");
  assert.equal(kakaoCameraStep(a, 760, t0 + 3000), "away");
  // Three minutes and never come to: done.
  const s: KakaoCamera = { since: t0, nearest: Infinity };
  assert.equal(kakaoCameraStep(s, 500, t0 + 181_000), "done");
});

test("a camera gone away from is not taken again until the car comes nearer to it than it was (a U-turn, a bend)", () => {
  assert.equal(stillAway(700, 760), true);
  assert.equal(stillAway(700, 680), true);
  assert.equal(stillAway(700, 640), false);
});
