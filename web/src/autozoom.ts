/**
 * How close the camera sits while following, the way TMAP and 카카오내비
 * do it: close in town, further out as the speed climbs (a car at 100 km/h
 * covers a screen's worth of road in seconds), and a little closer again
 * as a turn comes up, so the junction is big when it matters.
 *
 * Zooms are MapLibre's (512 px tiles): 18 is about 0.24 m a pixel here,
 * 16.5 about 0.67.
 */
const BY_SPEED: [kmh: number, zoom: number][] = [
  [0, 18.4], [20, 18.3], [40, 17.9], [60, 17.4], [80, 17.0], [100, 16.6], [130, 16.2],
];
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
