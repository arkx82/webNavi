import { angleBetween, bearing, metres } from "./geo";
import type { Feature } from "./warnings";
import type { LonLat } from "./types";

/**
 * A camera 카카오 told of (main.ts kakaoSay), judged on our side: 카카오's SDK is given no course (kakao-safety/
 * feeder.py), and on a divided road it tells the other carriageway's camera too — 청수가든앞 (G4699) on the way to
 * 무안 and 지산부대앞 (G7834), each morning of hantwo's 2026-11-05..12, our lists having both as the way home's.
 */

/** A carriageway this far from the car's heading runs against it (camera-layer.ts ahead, the same). */
export const AGAINST_DEG = 110;
/** A camera of ours this near 카카오's is the same camera. */
export const KAKAO_SAME_M = 80;

/** Whether every carriageway the camera stands on runs against [headingDeg]: the other way's camera. */
export function otherWays(f: Pick<Feature, "ways">, headingDeg: number): boolean {
  return !!f.ways?.length && f.ways.every((w) => w.deg >= 0 && angleBetween(headingDeg, w.deg) >= AGAINST_DEG);
}

/**
 * Whether 카카오's camera at [at] is one our lists have on the other carriageway, for a car heading [headingDeg]: a
 * camera of ours there, every one of them the other way's (the nearest given, for the log). Ours decide where they
 * have it, as on the route.
 */
export function otherWayCamera(ours: Iterable<Feature>, at: LonLat, headingDeg: number): Feature | null {
  let nearest: Feature | null = null, best = Infinity;
  for (const f of ours) {
    const d = metres(at[0], at[1], f.lon, f.lat);
    if (d > KAKAO_SAME_M) continue;
    if (!otherWays(f, headingDeg)) return null;
    if (d < best) { best = d; nearest = f; }
  }
  return nearest;
}

/** Further from its heading than this, a camera is behind the car… */
const BEHIND_DEG = 120;
/** …once this far from it (one beside the car is either). */
const BEHIND_FROM_M = 100;
/** Whether the camera at [cam] is behind a car at [at] heading [headingDeg]. */
export function behindCar(at: LonLat, headingDeg: number, cam: LonLat): boolean {
  if (metres(at[0], at[1], cam[0], cam[1]) < BEHIND_FROM_M) return false;
  return angleBetween(headingDeg, bearing(at[0], at[1], cam[0], cam[1])) > BEHIND_DEG;
}

/** The car came this near: it is at the camera. */
const AT_M = 60;
/** Gone this far back out from the nearest it came: past it, or (never at it) going away from it. */
const BACK_OUT_M = 30;
/** Away from a camera it never came to by this much: not on its road, or the other way (a GPS wobble is less). */
const AWAY_M = 50;
/** A camera passed is held this far on (warnings.ts CAMERA_ON_M); one told is held three minutes at most. */
const PAST_HELD_M = 300;
const HELD_MS = 180_000;

/** 카카오's camera while the car comes to it: when told, and the nearest the car has been. */
export interface KakaoCamera { since: number; nearest: number }

/**
 * Where the car is with 카카오's camera, now [d] metres from it: still coming to it, gone past it (its limit held on
 * a little, as our own cameras'), going away from it never having come to it (it was not this road's), or done.
 */
export function kakaoCameraStep(c: KakaoCamera, d: number, now: number): "coming" | "passed" | "away" | "done" {
  c.nearest = Math.min(c.nearest, d);
  if (now - c.since > HELD_MS) return "done";
  if (c.nearest < AT_M) {
    if (d <= c.nearest + BACK_OUT_M) return "coming";
    return d > PAST_HELD_M ? "done" : "passed";
  }
  return d > c.nearest + AWAY_M ? "away" : "coming";
}

/** Whether 카카오's camera [d] metres on is on the camera card: as ours, from 카메라 안내 시작 ([fromM]) in. */
export function kakaoCardShown(state: ReturnType<typeof kakaoCameraStep>, d: number, fromM: number): boolean {
  return state === "coming" && d <= fromM;
}
