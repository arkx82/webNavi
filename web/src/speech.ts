import { ENTRY_PHRASES, EVENTS, TOLL_PHRASES, TURN_NEAR_M, distanceWords, facilityPhrase, turnPhrase, type Facility, type Turn } from "../../server/src/phrases";
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
/**
 * On a fast road "잠시 후" comes this far out, not at TURN_NEAR_M: at 100 km/h 150 m is five seconds, the sentence
 * two of them. Kakao's SDK says it at 250 m on a motorway, 150 in town (KNVoiceDist).
 */
const FAST_NEAR_AT_M = 250;

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
const STRAIGHT_MATTERS = /방면|방향|고가|지하차도|진입|입구|램프|분기|갈림|본선|합류/;
/** Kakao's "12시 방향" at every IC a motorway passes: a clock hour names no choice. */
const CLOCK_WAY = /\d{1,2}\s*시\s*방향/g;
export function straightMatters(guideText: string): boolean {
  return STRAIGHT_MATTERS.test(guideText.replace(/\s*후\s.*$/, "").replace(CLOCK_WAY, ""));
}

/**
 * Into a 지하차도 or 고가차도, or the side road beside it, as the guide's
 * own action says it (the words after "방면으로", not the place it is at:
 * "조정지하차도에서 '광주' 방면으로 지하차도 진입"); null for any other guide.
 */
const FACILITY = /(왼쪽|오른쪽)?\s*(지하차도|고가차도|고가도로)\s*(왼쪽|오른쪽)?\s*(진입|옆길|옆)/;
export function facilityOf(guideText: string): Facility | null {
  const t = guideText.replace(/\s*후\s.*$/, "");
  const at = t.lastIndexOf("방면으로");
  const m = (at >= 0 ? t.slice(at + 4) : t).match(FACILITY);
  if (!m) return null;
  const side = (m[1] ?? m[3]) as Facility["side"];
  return { kind: m[2] === "지하차도" ? "지하차도" : "고가차도", how: m[4] === "진입" ? "진입" : "옆길", ...(side ? { side } : {}) };
}

const TOLL = /톨게이트|요금소/;
/** Onto a motorway or a 도시고속도로, as the words say it. */
const ENTRY = /(도시)?고속도로\s*(입구|진입)|자동차전용도로\s*진입/;

/** How far out rung [r] is said from: its own distance, but 잠시 후 sooner on a fast road. */
export function rungReach(r: number, fast: boolean): number {
  return r === TURN_NEAR_M && fast ? FAST_NEAR_AT_M : r;
}

/** The same, with the rung it was said at (a far one gets the junction's name and the side to move to). */
export function turnSay(maneuver: Maneuver, inM: number, speedKmh: number, said: Set<number>, guideText: string): { text: string; rung: number; fallback?: string } | null {
  if (maneuver === "depart") return null;
  const facility = maneuver === "arrive" ? null : facilityOf(guideText);
  // "잠시 후 직진" at every crossroads is noise: said only where the road gives a choice.
  if (!facility && maneuver === "straight" && !straightMatters(guideText)) return null;
  let rungs = rungsFor(speedKmh, said);
  const fast = rungs.includes(1000);
  const action = guideText.replace(/\s*후\s.*$/, "");
  const toll = !facility && TOLL.test(action);
  // Onto a motorway with no side to take: a fixed sentence, not the provider's list of places.
  const entry = !facility && !toll && (maneuver === "straight" || maneuver === "other") && ENTRY.test(action);
  // Straight on, a toll gate, a motorway entry and the arrival are said once, close in.
  if (!facility && (maneuver === "straight" || maneuver === "arrive" || toll || entry)) rungs = [TURN_NEAR_M];
  // A 지하차도 or 고가차도 is a lane to be in, not a turn: the nearer far rung and 잠시 후 (three under 미사대로 are nine sentences otherwise).
  if (facility) rungs = [fast ? 500 : 300, TURN_NEAR_M];
  const inside = rungs.filter((r) => inM <= rungReach(r, fast));
  if (inside.length === 0) return null;
  const rung = Math.min(...inside);
  if (said.has(rung)) return null;
  // The further rungs of this set are said with it: none is owed after a nearer one.
  for (const r of rungs) if (r >= rung) said.add(r);
  // First seen well inside a far rung (just re-routed, or a guide that
  // came late): "500미터 앞" at 170 m is wrong, so wait for 잠시 후 instead.
  if (rung > TURN_NEAR_M && inM < rung * FAR_ENOUGH) return null;
  if (maneuver === "arrive") return { text: EVENTS.nearGoal, rung };
  if (toll) return { text: /하이패스/.test(guideText) ? TOLL_PHRASES.hipass : TOLL_PHRASES.plain, rung };
  if (entry) return { text: /도시고속도로/.test(action) ? ENTRY_PHRASES.city : ENTRY_PHRASES.motorway, rung };
  const plain = TURNS.has(maneuver) ? turnPhrase(maneuver as Turn, rung) : undefined;
  if (facility) return { text: facilityPhrase(facility, rung), rung, ...(plain ? { fallback: plain } : {}) };
  if (plain) return { text: plain, rung };
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
