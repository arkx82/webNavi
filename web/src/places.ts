import type { Place } from "./types";

/**
 * 집, 회사 and 즐겨찾기 — the car apps' saved places. NAVER, Kakao and
 * TMAP keep theirs to themselves (no public API gives a user's saved
 * places), so they are set here, and kept in the car's browser: the car
 * page has no lock yet, and a home address on the server would be anyone's
 * to read. They move to the server with the access key.
 */
export interface Saved {
  home: Place | null;
  work: Place | null;
  favourites: Place[];
}

const KEY = "nav-places";

export function loadPlaces(): Saved {
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>;
    return { home: kept.home ?? null, work: kept.work ?? null, favourites: kept.favourites ?? [] };
  } catch {
    return { home: null, work: null, favourites: [] };
  }
}

export function savePlaces(s: Saved) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private window */ }
}

/** The same place, give or take a few metres and whatever name the search gave it. */
export function samePlace(a: Place | null | undefined, b: Place | null | undefined): boolean {
  if (!a || !b) return false;
  const dx = (a.at[0] - b.at[0]) * 88_000, dy = (a.at[1] - b.at[1]) * 111_000;
  return Math.hypot(dx, dy) < 30;
}

export function isFavourite(s: Saved, p: Place): boolean {
  return s.favourites.some((f) => samePlace(f, p));
}

/** Adds [p] to the favourites, or takes it off if it is there already; the list keeps the newest first. */
export function toggleFavourite(s: Saved, p: Place): Saved {
  const favourites = isFavourite(s, p) ? s.favourites.filter((f) => !samePlace(f, p)) : [p, ...s.favourites].slice(0, 30);
  return { ...s, favourites };
}
