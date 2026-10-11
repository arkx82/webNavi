import type { Maneuver } from "./maneuver";
import type { Guide } from "./types";

/**
 * 분기점 확대: before a junction a driver can get wrong — an IC, a JC, a
 * motorway exit or entrance, a ramp onto a flyover or into an underpass —
 * the camera tilts further and draws back just enough that the car (at
 * the foot of the screen) and the fork are both in view, with the route
 * drawn over the base map's own road shapes. It is the car apps'
 * junction picture made from the map itself: no provider hands those out.
 */
export const CLOSEUP_MOTORWAY_M = 500;
export const CLOSEUP_TOWN_M = 250;
/** Kept this far past the junction, so the branch taken is seen being taken. */
export const CLOSEUP_AFTER_M = 100;
export const CLOSEUP_PITCH = 60;
/** Where the car sits: this share of the screen's height from the top. */
export const CLOSEUP_CAR_AT = 0.84;

const TRICKY_WORDS = /IC|JC|분기|출구|진출|진입|입구|램프|고가|지하차도|도시고속|나들목/;
const FORKS = new Set<Maneuver>(["slight-left", "slight-right", "ramp-left", "ramp-right", "sharp-left", "sharp-right"]);

/** Whether [guide] is one to show close up: a fork on a motorway, or any junction its words say is tricky. */
export function isTricky(guide: Pick<Guide, "text" | "name">, m: Maneuver, motorway: boolean): boolean {
  if (m === "arrive" || m === "depart" || m === "straight" || m === "uturn") return false;
  if (motorway && FORKS.has(m)) return true;
  return TRICKY_WORDS.test(`${guide.text} ${guide.name ?? ""}`);
}

/** From how far a tricky junction is shown close up. */
export function closeupFrom(motorway: boolean): number {
  return motorway ? CLOSEUP_MOTORWAY_M : CLOSEUP_TOWN_M;
}

/**
 * The zoom at which [aheadM] metres of road, plus a little past the
 * junction, fill [pixels] of the screen's height at [lat]. MapLibre's
 * 512 px tiles; the tilt shortens the far part, which the margin allows for.
 */
export function zoomToSee(aheadM: number, lat: number, pixels: number): number {
  const span = Math.max(SEE_MIN_M, aheadM + SEE_PAST_M);
  const metresPerPixel = span / Math.max(200, pixels);
  const z = Math.log2((40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * metresPerPixel)) + TILT_GAIN;
  return Math.max(SEE_ZOOM_MIN, Math.min(SEE_ZOOM_MAX, z));
}
/**
 * Past the junction, enough to see which branch the line takes: it was 150 m, and with the following zoom raised a
 * level (autozoom.ts, 2026-10-11) the close-up drew back further than the plain view, 140 m before a fork at 30 km/h.
 */
const SEE_PAST_M = 60;
/**
 * The tilt's reach, in zoom levels: at 60° with the car at 0.84 of the height and the screen's middle the camera's,
 * the ground from the car up to 0.12 is 2.55 times the flat scale's 0.72 heights (log2 1.35); kept a little short.
 * It was 0.6, and the fork sat well below the top.
 */
const TILT_GAIN = 1.1;
const SEE_MIN_M = 80;
/** As close as the plain view at a crawl, and never so far that the fork is a speck. */
export const SEE_ZOOM_MIN = 16;
export const SEE_ZOOM_MAX = 19.2;

export interface Closeup { guide: Guide; inM: number; label: string }

/** What the hold asks of a guide, from the route it is on (main.ts keeps the tables). */
export interface CloseupJudge {
  motorway(g: Guide): boolean;
  maneuver(g: Guide): Maneuver;
  label(g: Guide): string;
}

/**
 * Which junction is shown close up this frame: the next tricky one once it
 * is near enough, and kept CLOSEUP_AFTER_M past it so the branch is seen
 * being taken. Where each was passed is measured along the route, so a new
 * route (a re-route, a quicker way) must reset(): held over, an old guide's
 * metres read against the new line as kilometres still to go, and the view
 * stayed tilted and drawn back for all of them.
 */
export class CloseupHold {
  private shown: Closeup | null = null;
  private passedAt = new Map<Guide, number>();

  constructor(private judge: CloseupJudge) {}

  /** A new route: nothing of the old one is held. */
  reset() {
    this.shown = null;
    this.passedAt.clear();
  }

  frame(alongM: number | undefined, next: { guide: Guide; inM: number } | undefined): Closeup | null {
    this.shown = this.pick(alongM, next);
    return this.shown;
  }

  private pick(alongM: number | undefined, next: { guide: Guide; inM: number } | undefined): Closeup | null {
    // Still just past the one shown: kept until CLOSEUP_AFTER_M beyond it.
    if (this.shown && alongM != null) {
      const past = this.passedAt.get(this.shown.guide);
      if (past != null && alongM - past < CLOSEUP_AFTER_M) return { ...this.shown, inM: past - alongM };
    }
    if (!next) return null;
    const motorway = this.judge.motorway(next.guide);
    if (next.inM > closeupFrom(motorway) || !isTricky(next.guide, this.judge.maneuver(next.guide), motorway)) return null;
    if (alongM != null) this.passedAt.set(next.guide, alongM + next.inM);
    return { guide: next.guide, inM: next.inM, label: this.judge.label(next.guide) };
  }
}
