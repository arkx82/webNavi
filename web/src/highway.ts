import { LANE_HINTS, distanceWords, turnWord, type Turn } from "../../server/src/phrases";
import { Line } from "./geo";
import type { Maneuver } from "./maneuver";
import type { Feature } from "./warnings";
import type { Guide, Route } from "./types";

/**
 * What a motorway junction adds to a turn: its name and the way it leads
 * ("신갈JC에서 원주 방면"), read from the provider's guide text — TMAP and
 * NAVER write both, Kakao the 방면 and, in the guide's name, the place —
 * which side to be on a kilometre out, and where the car merges after an
 * entrance. None of it is lane data (no provider gives that): the side is
 * the side of the turn.
 */
export interface Junction {
  /** "신갈JC", "용인IC", "신갈분기점" … */
  name?: string;
  /** The first place the signs point to: "원주". */
  toward?: string;
}

const PLACE = /([가-힣A-Za-z0-9]+(?:IC|JC|TG|분기점|나들목|요금소|톨게이트))/;
const PLACE_AT = new RegExp(`${PLACE.source}에서`);
const TOWARD = /['‘"]?([가-힣A-Za-z0-9 ,·]+?)['’"]?\s*방면/;
const FIRST_OF = /[,·]/;
const AFTER_AT = /^.*에서\s*/;
const SPACES = /\s+/;
/** Read once a guide: the close-up, the lane card and the sentence ask for it every frame. */
const known = new WeakMap<object, Junction | null>();

export function junctionOf(guide: Pick<Guide, "text" | "name">): Junction | null {
  const had = known.get(guide);
  if (had !== undefined) return had;
  const j = readJunction(guide);
  known.set(guide, j);
  return j;
}

function readJunction(guide: Pick<Guide, "text" | "name">): Junction | null {
  const text = guide.text ?? "";
  const name = text.match(PLACE_AT)?.[1] ?? (guide.name && PLACE.test(guide.name) ? guide.name.match(PLACE)![1] : undefined);
  const toward = text.match(TOWARD)?.[1]?.split(FIRST_OF)[0]?.replace(AFTER_AT, "").trim().split(SPACES)[0];
  if (!name && !toward) return null;
  return { name, toward: toward || undefined };
}

/** "1킬로미터 앞 신갈JC에서 원주 방면, 왼쪽 방향입니다" — made by the voice service the first time, then kept. */
export function namedTurnPhrase(turn: Turn, rungM: number, j: Junction): string | null {
  const where = [j.name && `${j.name}에서`, j.toward && `${j.toward} 방면`].filter(Boolean).join(" ");
  if (!where) return null;
  return `${distanceWords(rungM)} 앞 ${where}, ${turnWord(turn)}입니다`;
}

/** The side to move to before a turn off a motorway, or null for one that keeps the lane. */
export function laneHint(m: Maneuver): string | null {
  if (m === "ramp-right" || m === "slight-right" || m === "right" || m === "sharp-right") return LANE_HINTS.right;
  if (m === "ramp-left" || m === "slight-left" || m === "left" || m === "sharp-left") return LANE_HINTS.left;
  return null;
}

/** Whether the route's path at vertex [i] is on a motorway. */
export function motorwayAt(route: Route, i: number): boolean {
  return !!route.motorways?.some(([from, to]) => i >= from && i < to);
}

/** Whether the road is a motorway just before a guide and a little after it, or null where the route does not say. */
export function motorwaySides(route: Route, line: Line, g: Pick<Guide, "at">): { before: boolean; after: boolean } | null {
  if (!route.motorways) return null;
  const p = line.project(g.at, 0, line.path.length);
  return {
    before: motorwayAt(route, line.place(Math.max(0, p.alongM - SIDES_BEFORE_M)).segment),
    after: motorwayAt(route, line.place(Math.min(line.lengthM, p.alongM + SIDES_AFTER_M)).segment),
  };
}
const SIDES_BEFORE_M = 60;
const SIDES_AFTER_M = 150;

export type JunctionKind = "fork" | "exit" | "enter";
/**
 * What a motorway junction is — a fork (a JC), an exit off the main road,
 * or an entrance onto it — from the road first: on a motorway before and
 * after the guide is a fork, before only an exit, after only an entrance.
 * The words settle it only where they are plain (출구·진출) or the road
 * does not say. "진입" alone is never an entrance: Kakao writes it at a JC
 * branch too ("인천 원주 방면으로 오른쪽 고속도로 진입" at 신갈JC), and the
 * entrance picture there showed a ramp merging from the wrong side.
 */
export function junctionKind(text: string, road: { before: boolean; after: boolean } | null): JunctionKind {
  if (/출구|진출/.test(text)) return "exit";
  if (road) {
    if (road.before && road.after) return "fork";
    if (road.before) return "exit";
    if (road.after) return "enter";
  }
  if (/입구/.test(text)) return "enter";
  return "fork";
}

/** A ramp onto a motorway (or a junction's link road onto the next one) is this long before it meets the main road. */
const ENTRANCE_RAMP_M = 300;
const JUNCTION_RAMP_M = 450;

/**
 * Where the route merges onto a motorway: past each entrance by a ramp's
 * length, and past each junction branch by a link road's. The warning is
 * said 150 m before that (phrases.ts), so on the ramp.
 */
export function findMerges(route: Route): Feature[] {
  if (route.path.length < 2) return [];
  const line = new Line(route.path);
  const out: Feature[] = [];
  route.guides.forEach((g, n) => {
    const p = line.project(g.at, 0, route.path.length);
    // An entrance is from off the motorway: the same words at a JC branch (Kakao's "고속도로 진입") are no entrance.
    const entrance = /고속도로\s*(입구|진입)|도시고속도로\s*(입구|진입)|자동차전용도로\s*(입구|진입)/.test(g.text)
      && !motorwayAt(route, line.place(Math.max(0, p.alongM - SIDES_BEFORE_M)).segment);
    const branch = !entrance && /JC|분기점/.test(`${g.text} ${g.name ?? ""}`) && /방향|분기|진입/.test(g.text) && motorwayAt(route, p.segment);
    if (!entrance && !branch) return;
    const at = p.alongM + (entrance ? ENTRANCE_RAMP_M : JUNCTION_RAMP_M);
    if (at >= line.lengthM - 50) return;
    const [lon, lat] = line.place(at).at;
    out.push({ id: `merge:${n}:${Math.round(p.alongM)}`, kind: "merge", lon, lat });
  });
  return out;
}
