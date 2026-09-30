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
  const span = Math.max(120, aheadM + CLOSEUP_AFTER_M * 1.5);
  const metresPerPixel = span / Math.max(200, pixels);
  const z = Math.log2((40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * metresPerPixel)) + 0.6;
  return Math.max(15.5, Math.min(18.3, z));
}

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
