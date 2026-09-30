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
    const entrance = /고속도로\s*(입구|진입)|도시고속도로\s*(입구|진입)|자동차전용도로\s*(입구|진입)/.test(g.text);
    const p = line.project(g.at, 0, route.path.length);
    const branch = !entrance && /JC|분기점/.test(g.text) && /방향|분기/.test(g.text) && motorwayAt(route, p.segment);
    if (!entrance && !branch) return;
    const at = p.alongM + (entrance ? ENTRANCE_RAMP_M : JUNCTION_RAMP_M);
    if (at >= line.lengthM - 50) return;
    const [lon, lat] = line.place(at).at;
    out.push({ id: `merge:${n}:${Math.round(p.alongM)}`, kind: "merge", lon, lat });
  });
  return out;
}
