import { ENTRY_PHRASES, EVENTS, TOLL_PHRASES, TURN_NEAR_M, distanceWords, facilityPhrase, turnPhrase, type Facility, type Turn } from "../../server/src/phrases";
import type { Maneuver } from "./maneuver";

/**
 * What the voice says for the next turn, and when: the car apps' fixed
 * sentences (server/src/phrases.ts, all rendered ahead of time) at TMAP's
 * own distances, then "잠시 후" close in. The provider's own guide text is
 * only for the screen, except for a manoeuvre the vocabulary has no word for.
 */
export { EVENTS };

/** The road a turn is approached on: TMAP picks its distances by the road's class, not the car's speed. */
export type RoadKind = "town" | "fast";

/**
 * One distance a turn is said at: the words ([m], or 잠시 후 for TURN_NEAR_M)
 * and the window it is said in — once, as the turn first comes inside
 * [from, to]. Past the window unsaid (a guide first known closer in, a
 * re-route), it is not said at all: "500미터 앞" at 170 m is wrong.
 */
export interface Rung { m: number; from: number; to: number }

/**
 * TMAP's navigation engine's defaults (RGConfig in TmapNavigationEngine
 * 11.0.0.1090, checked 2026-10-02 — its camera warnings there, 1 km on a
 * motorway and 600 m in town, are what TMAP's own help page says the app
 * does). 일반도로: 1 km, 500 m, 300 m, then 잠시 후 within 130 m.
 * 고속국도 and 도시고속화도로: 2 km, 1 km, 600 m, then 잠시 후 within 220 m.
 */
const TOWN_RUNGS: Rung[] = [{ m: 1000, from: 950, to: 1050 }, { m: 500, from: 450, to: 550 }, { m: 300, from: 250, to: 350 }, { m: TURN_NEAR_M, from: 0, to: 130 }];
const FAST_RUNGS: Rung[] = [{ m: 2000, from: 1950, to: 2050 }, { m: 1000, from: 950, to: 1050 }, { m: 600, from: 550, to: 699 }, { m: TURN_NEAR_M, from: 0, to: 220 }];

/** The distances a turn is said at, on [road]. */
export function turnRungs(road: RoadKind): Rung[] {
  return road === "fast" ? FAST_RUNGS : TOWN_RUNGS;
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
export function turnSpeech(maneuver: Maneuver, inM: number, road: RoadKind, said: Set<number>, guideText: string): string | null {
  return turnSay(maneuver, inM, road, said, guideText)?.text ?? null;
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

/** The same, with the rung it was said at (a far one gets the junction's name and the side to move to). */
export function turnSay(maneuver: Maneuver, inM: number, road: RoadKind, said: Set<number>, guideText: string): { text: string; rung: number; fallback?: string } | null {
  if (maneuver === "depart") return null;
  const facility = maneuver === "arrive" ? null : facilityOf(guideText);
  // "잠시 후 직진" at every crossroads is noise: said only where the road gives a choice.
  if (!facility && maneuver === "straight" && !straightMatters(guideText)) return null;
  const all = turnRungs(road);
  const near = all[all.length - 1];
  let rungs = all;
  const action = guideText.replace(/\s*후\s.*$/, "");
  const toll = !facility && TOLL.test(action);
  // Onto a motorway with no side to take: a fixed sentence, not the provider's list of places.
  const entry = !facility && !toll && (maneuver === "straight" || maneuver === "other") && ENTRY.test(action);
  // Straight on, a toll gate, a motorway entry and the arrival are said once, close in.
  if (!facility && (maneuver === "straight" || maneuver === "arrive" || toll || entry)) rungs = [near];
  // A 지하차도 or 고가차도 is a lane to be in, not a turn: the last far rung and 잠시 후 (three under 미사대로 are nine sentences otherwise).
  if (facility) rungs = all.slice(-2);
  const at = rungs.find((r) => inM <= r.to && inM >= r.from);
  if (!at || said.has(at.m)) return null;
  // The further rungs are done with: none is owed after a nearer one.
  for (const r of all) if (r.m >= at.m) said.add(r.m);
  const rung = at.m;
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
