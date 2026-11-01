/**
 * How close the camera sits while following, the way TMAP and 카카오내비
 * do it: close in town, further out as the speed climbs (a car at 100 km/h
 * covers a screen's worth of road in seconds), and a little closer again
 * as a turn comes up, so the junction is big when it matters.
 *
 * Zooms are MapLibre's (512 px tiles): 18 is about 0.24 m a pixel here,
 * 16.5 about 0.67. The table is the car apps' distance: on the car's
 * screen (804 × 638, tilted 55°) about 240 m of road ahead standing, 400 m
 * at 60 km/h, 700 m at 100 (measured 2026-11-01 on the pretend drive). It
 * was a level closer, so that the painted lanes read in town; the owner
 * found the apps' scale the familiar one, and the lanes are no longer
 * drawn — a road is one line, and the lane card says which lane. 지도
 * 거리 "가깝게" (CLOSE_ZOOM) puts the old scale back.
 */
const BY_SPEED: [kmh: number, zoom: number][] = [
  [0, 18.3], [30, 18.1], [60, 17.5], [80, 17.1], [100, 16.7], [130, 16.3],
];
/** 지도 거리 가깝게: the level closer the map was until 2026-11-01. */
export const CLOSE_ZOOM = 0.9;
/** From this far out a turn starts drawing the camera in, up to TURN_ZOOM at the junction. */
export const TURN_M = 300;
export const TURN_ZOOM = 0.5;

export function zoomForSpeed(kmh: number): number {
  if (!(kmh > BY_SPEED[0][0])) return BY_SPEED[0][1];
  for (let i = 1; i < BY_SPEED.length; i++) {
    const [s1, z1] = BY_SPEED[i];
    if (kmh <= s1) {
      const [s0, z0] = BY_SPEED[i - 1];
      return z0 + ((kmh - s0) / (s1 - s0)) * (z1 - z0);
    }
  }
  return BY_SPEED[BY_SPEED.length - 1][1];
}

/** The zoom to follow at: by speed, drawn in by a near turn, moved by the view's own shift. */
export function autoZoom(kmh: number, turnInM: number | undefined, shift = 0): number {
  const near = turnInM == null ? 0 : Math.max(0, 1 - turnInM / TURN_M);
  return zoomForSpeed(kmh) + near * TURN_ZOOM + shift;
}
