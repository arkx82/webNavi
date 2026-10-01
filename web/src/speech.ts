import { EVENTS, TURN_NEAR_M, distanceWords, turnPhrase, type Turn } from "../../server/src/phrases";
import type { Maneuver } from "./maneuver";

/**
 * What the voice says for the next turn, and when: the car apps' fixed
 * sentences (server/src/phrases.ts, all rendered ahead of time) at a few
 * distances — 1 km and 500 m on a fast road, 500 m and 300 m in town — then
 * "잠시 후" close in. The provider's own guide text is only for the screen,
 * except for a manoeuvre the vocabulary has no word for.
 */
export { EVENTS };

/** A far rung is said only this close to its distance: 500 m from 350 m out, not from 170. */
const FAR_ENOUGH = 0.7;

const FAST_RUNGS = [1000, 500, TURN_NEAR_M];
const TOWN_RUNGS = [500, 300, TURN_NEAR_M];

/** The distances a turn is spoken at, for the speed the car is doing. */
export function turnRungs(speedKmh: number): number[] {
  return [...(speedKmh >= 70 ? FAST_RUNGS : TOWN_RUNGS)];
}

/**
 * The set a junction's turn is said from is settled by its first sentence,
 * read back from what was said: a car doing 75 that dips to 65 and back
 * sticks with the fast road rungs without adding an extra 300m.
 */
function rungsFor(speedKmh: number, said: Set<number>): number[] {
  if (said.has(1000)) return [...FAST_RUNGS];
  if (said.has(300)) return [...TOWN_RUNGS];
  return turnRungs(speedKmh);
}

const TURNS = new Set<Maneuver>([
  "straight", "left", "right", "slight-left", "slight-right", "sharp-left", "sharp-right",
  "uturn", "ramp-left", "ramp-right", "roundabout",
]);

/**
 * The sentence due for a turn [inM] ahead, or null. Of the rungs the car
 * is inside, only the nearest counts, and saying it marks the further ones
 * said too: a guide first seen 120 m out is "잠시 후", not "300미터 앞" and
 * then "잠시 후" in one breath.
 */
export function turnSpeech(maneuver: Maneuver, inM: number, speedKmh: number, said: Set<number>, guideText: string): string | null {
  return turnSay(maneuver, inM, speedKmh, said, guideText)?.text ?? null;
}

/**
 * Whether a straight-on guide is worth saying: the providers put one at
 * many a plain crossroads, where "잠시 후 직진" only distracts. It is
 * kept where its words name a choice — a direction to hold ("…방면",
 * "…방향"), a flyover or underpass to take or leave, a road to enter.
 */
const STRAIGHT_MATTERS = /방면|방향|고가|지하차도|진입|램프|분기|갈림|본선|합류/;
export function straightMatters(guideText: string): boolean {
  return STRAIGHT_MATTERS.test(guideText.replace(/\s*후\s.*$/, ""));
}

/** The same, with the rung it was said at (a far one gets the junction's name and the side to move to). */
export function turnSay(maneuver: Maneuver, inM: number, speedKmh: number, said: Set<number>, guideText: string): { text: string; rung: number } | null {
  if (maneuver === "depart") return null;
  // "잠시 후 직진" at every crossroads is noise: said only where the road gives a choice.
  if (maneuver === "straight" && !straightMatters(guideText)) return null;
  let rungs = rungsFor(speedKmh, said);
  // Straight on and the arrival are said once, close in.
  if (maneuver === "straight" || maneuver === "arrive") rungs = [TURN_NEAR_M];
  const inside = rungs.filter((r) => inM <= r);
  if (inside.length === 0) return null;
  const rung = Math.min(...inside);
  if (said.has(rung)) return null;
  // The further rungs of this set are said with it: none is owed after a nearer one.
  for (const r of rungs) if (r >= rung) said.add(r);
  // First seen well inside a far rung (just re-routed, or a guide that
  // came late): "500미터 앞" at 170 m is wrong, so wait for 잠시 후 instead.
  if (rung > TURN_NEAR_M && inM < rung * FAR_ENOUGH) return null;
  if (maneuver === "arrive") return { text: EVENTS.nearGoal, rung };
  if (TURNS.has(maneuver)) return { text: turnPhrase(maneuver as Turn, rung), rung };
  const short = spokenGuide(guideText);
  if (!short) return null;
  return { text: rung <= TURN_NEAR_M ? `잠시 후 ${short}` : `${distanceWords(rung)} 앞 ${short}`, rung };
}

/**
 * A provider's guide text, made sayable: without the "…후 …을 따라 15m 이동"
 * tail, the quotes and brackets, and with metres in words.
 */
export function spokenGuide(text: string): string {
  return text
    .replace(/\s*후\s+.*?(을|를)?\s*따라\s*\d+\s*m\s*이동\s*$/, "")
    .replace(/\s*(을|를)\s*따라\s*\d+\s*m\s*이동\s*$/, "")
    .replace(/[“”"'‘’]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/(\d+)\s*m\b/g, "$1미터")
    .replace(/\s+/g, " ")
    .trim();
}
