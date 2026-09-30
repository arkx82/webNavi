import { metres } from "./geo";
import { push } from "./userdata";
import type { LonLat, Place, Provider } from "./types";

/**
 * What a closed browser comes back to: the drive that was going on (where
 * to, with whom), kept in this browser and for the user on the server, so
 * a reopened page — or the car, after the phone — takes it up again; and
 * where the car last was, so the map opens there rather than at the
 * default before the first fix comes.
 */
export interface DriveState {
  to: Place;
  provider: Provider;
  /** Last written while driving; an old one is a drive long over. */
  at: number;
}

const DRIVE_KEY = "nav-drive";
const LAST_KEY = "nav-last-at";
/** A drive not touched for this long is not taken up again. */
export const RESUME_WITHIN_MS = 3 * 3600_000;
const LAST_EVERY_MS = 30_000;

const read = <T>(k: string): T | null => { try { return JSON.parse(localStorage.getItem(k) ?? "null") as T | null; } catch { return null; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } };

export function saveDrive(state: DriveState | null) {
  write(DRIVE_KEY, state);
  push("drive", state);
}

/** The drive to take up again, if one was going on lately. */
export function loadDrive(now = Date.now()): DriveState | null {
  const s = read<DriveState>(DRIVE_KEY);
  if (!s?.to?.at || !s.provider || !(now - s.at < RESUME_WITHIN_MS)) return null;
  return s;
}

/** Closer than this to the destination, the kept drive is over: taken up again, it would announce the arrival once more. */
export const RESUME_MIN_M = 150;
/** Whether [s] is worth taking up from [here] (unknown: yes, the fix may come later). */
export function worthResuming(s: DriveState, here: LonLat | null): boolean {
  return !here || metres(here[0], here[1], s.to.at[0], s.to.at[1]) > RESUME_MIN_M;
}

let lastWritten = 0;
export function saveLast(at: LonLat, now = Date.now()) {
  if (now - lastWritten < LAST_EVERY_MS) return;
  lastWritten = now;
  write(LAST_KEY, { at, t: now });
}

export function loadLast(): LonLat | null {
  const l = read<{ at: LonLat }>(LAST_KEY);
  return l?.at && l.at.every(Number.isFinite) ? l.at : null;
}
