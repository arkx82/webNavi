import type { LonLat } from "./types";

/**
 * 낮 and 밤: a light screen by day, a dark one (and a dimmed map) by night,
 * the way the car's own screen goes — by where the sun is for the car,
 * worked out here (NOAA's formulas, to a minute or so), or as the driver
 * chose in 안내 설정.
 */
export type Theme = "auto" | "light" | "dark";

/** The sun's height above the horizon in degrees at [ms] for a place. */
export function sunAltitude(ms: number, at: LonLat): number {
  const rad = Math.PI / 180;
  const d = ms / 86_400_000 + 2440587.5 - 2451545.0; // days since J2000
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const l = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l));
  const dec = Math.asin(Math.sin(e) * Math.sin(l));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst * 15 + at[0]) * rad) - ra;
  const lat = at[1] * rad;
  return Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha)) / rad;
}

/** Night once the sun is down past civil twilight's start (a little after sunset, as the car dims its screen). */
export function isNight(ms: number, at: LonLat): boolean {
  return sunAltitude(ms, at) < -2;
}

/** Sets the screen's theme; true when it is day. */
export function applyTheme(choice: Theme, at: LonLat, now = Date.now()): boolean {
  const night = choice === "dark" || (choice === "auto" && isNight(now, at));
  document.body.classList.toggle("night", night);
  document.body.classList.toggle("day", !night);
  return !night;
}
