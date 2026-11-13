import { metres } from "./road/ahead.js";
import type { LonLat } from "./road/limits.js";

/**
 * Points a page sends, checked before anything is done along them. Finite was all that was asked: four points across
 * the date line made 1.2 million samples in limits.ts (and as many asks of TMAP's paid API), and 1e300 a loop with no
 * end (review, 2026-11-13). Everything here is Korea's: its roads, its maps, its cameras.
 */

/** Korea and its seas, with a margin: 제주 and 마라도 (33.1°N) to 온성 (43°N), 백령도 (124.6°E) to 독도 (131.9°E). */
const WEST = 123, EAST = 133, SOUTH = 32, NORTH = 44;

/** A [lon, lat] in Korea. */
export function inKorea(p: unknown): p is LonLat {
  return Array.isArray(p) && p.length === 2 && typeof p[0] === "number" && typeof p[1] === "number"
    && p[0] >= WEST && p[0] <= EAST && p[1] >= SOUTH && p[1] <= NORTH;
}

/** How long a path runs, metres. */
export function pathM(path: LonLat[]): number {
  let m = 0;
  for (let i = 1; i < path.length; i++) m += metres(path[i - 1], path[i]);
  return m;
}

/** A route's path, as long as the longest drive in the country goes and some (고성 to 해남 is about 700 km by road). */
export const ROUTE_MAX_M = 2_000_000;
