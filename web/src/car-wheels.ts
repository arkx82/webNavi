import type * as THREE_NS from "three";

/**
 * The 3D car's wheels (tools/car-model/process.mjs cuts them out about their axles as wheelFL … wheelRR): rolled by the
 * speed, the front ones steered by how fast the heading turns. Kept apart from car-model.ts (which brings MapLibre) so
 * the 3D 분기점 panel and its worker take only this.
 */
/** The tyres' radius and the axles' distance in the model (the Model Y L's: the model's 2.904 m stretched as car-model.ts stretches it). */
const WHEEL_RADIUS_M = 0.368;
const WHEELBASE_M = 2.904 * (4.976 / 4.78);
/**
 * How fast a wheel is seen to turn at most, radians a second: at 100 km/h a tyre turns twelve times a second, and drawn
 * thirty or sixty times a second its rim stood still or ran backwards. Two turns a second reads as rolling.
 */
const MAX_SPIN = 12;
/** The front wheels turned this far at most (radians), and eased to it over this long (seconds). */
const MAX_STEER = 0.5;
const STEER_EASE_S = 0.25;

/** The model's four wheels (wheelFL … wheelRR), how far they have turned, and how far the front ones are turned. */
export interface Wheels { all: THREE_NS.Object3D[]; front: THREE_NS.Object3D[]; spin: number; steer: number }

/** The wheels of a loaded model; null for a model without them cut out (an older car-model.glb). */
export function findWheels(model: THREE_NS.Object3D): Wheels | null {
  const by = (n: string) => model.getObjectByName(n) ?? null;
  const [fl, fr, rl, rr] = ["wheelFL", "wheelFR", "wheelRL", "wheelRR"].map(by);
  if (!fl || !fr || !rl || !rr) return null;
  // Turned about the car's up (steering) after rolling about the axle.
  for (const w of [fl, fr, rl, rr]) w.rotation.order = "YXZ";
  return { all: [fl, fr, rl, rr], front: [fl, fr], spin: 0, steer: 0 };
}

/**
 * The wheels rolled on for [dt] seconds at [speedMps] on the ground — the car drawn [scale] times its size, so are its
 * tyres — and the front ones turned for a heading turning at [yawRate] radians a second (right positive): the angle a
 * car of this wheelbase would steer at that speed and turn, eased.
 */
export function rollWheels(w: Wheels, speedMps: number, yawRate: number, dt: number, scale = 1) {
  if (!(dt > 0)) return;
  const v = Math.max(0, speedMps);
  w.spin = (w.spin - Math.min(MAX_SPIN, v / (WHEEL_RADIUS_M * Math.max(1, scale))) * dt) % (2 * Math.PI);
  const want = v > 1 ? Math.max(-MAX_STEER, Math.min(MAX_STEER, Math.atan((WHEELBASE_M * yawRate) / v))) : w.steer;
  w.steer += (want - w.steer) * (1 - Math.exp(-dt / STEER_EASE_S));
  for (const x of w.all) x.rotation.x = w.spin;
  // The model's front is −Z: a turn to the right is a negative turn about its up.
  for (const x of w.front) x.rotation.y = -w.steer;
}
