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
 * How far a wheel is seen to turn in one frame at most (radians, 15°): its rim's ten spokes repeat every 36°, and a
 * turn of more than half that between two frames reads as standing or running backwards — at 100 km/h a tyre turns
 * twelve times a second, the car draws thirty frames. Up to it the wheel turns with the speed (a tanh: as the speed slow, easing into the most).
 */
const MAX_STEP = (15 * Math.PI) / 180;
/** From this speed (m/s) a blur over the rim's face comes up, all there by BLUR_FULL: the spokes give way to a spinning disc. */
const BLUR_FROM = 40 / 3.6;
const BLUR_FULL = 80 / 3.6;
const BLUR_MAX = 0.85;
/** The front wheels turned this far at most (radians), and eased to it over this long (seconds). */
const MAX_STEER = 0.5;
const STEER_EASE_S = 0.25;

/** The model's four wheels (wheelFL … wheelRR), how far they have turned, how far the front ones are turned, the blurs. */
export interface Wheels { all: THREE_NS.Object3D[]; front: THREE_NS.Object3D[]; spin: number; steer: number; blurs: { opacity: number }[] }

/**
 * The wheels of a loaded model; null for a model without them cut out (an older car-model.glb). With three [T], each
 * gets its blur: a disc on its outer face, as wide as the rim, seen only at speed.
 */
export function findWheels(model: THREE_NS.Object3D, T?: typeof THREE_NS): Wheels | null {
  const by = (n: string) => model.getObjectByName(n) ?? null;
  const [fl, fr, rl, rr] = ["wheelFL", "wheelFR", "wheelRL", "wheelRR"].map(by);
  if (!fl || !fr || !rl || !rr) return null;
  // Turned about the car's up (steering) after rolling about the axle.
  for (const w of [fl, fr, rl, rr]) w.rotation.order = "YXZ";
  const blurs: { opacity: number }[] = [];
  if (T) {
    model.updateWorldMatrix(true, true);
    const map = blurTexture(T);
    for (const w of [fl, fr, rl, rr]) {
      // The wheel's tyre and rim in its own frame: the outer face (away from the car's middle), the rim's radius.
      const into = new T.Matrix4().copy(w.matrixWorld).invert();
      const tyre = new T.Box3(), rim = new T.Box3();
      w.traverse((o) => {
        const m = o as THREE_NS.Mesh;
        if (!m.isMesh) return;
        m.geometry.computeBoundingBox();
        const b = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld).applyMatrix4(into);
        (m.name.startsWith("Rubber") ? tyre : rim).union(b);
      });
      if (tyre.isEmpty() || rim.isEmpty()) continue;
      const out = w.position.x < 0 ? -1 : 1;
      const radius = Math.max(rim.max.y - rim.min.y, rim.max.z - rim.min.z) / 2;
      const material = new T.MeshBasicMaterial({ map, transparent: true, opacity: 0, depthWrite: false });
      const disc = new T.Mesh(new T.CircleGeometry(radius * 1.02, 40), material);
      disc.rotation.y = (out * Math.PI) / 2;
      disc.position.set((out > 0 ? tyre.max.x : tyre.min.x) * 0.92, 0, 0);
      disc.renderOrder = 2;
      w.add(disc);
      blurs.push(material);
    }
  }
  return { all: [fl, fr, rl, rr], front: [fl, fr], spin: 0, steer: 0, blurs };
}

/** A spinning rim's look: dark at the hub, the spokes' grey smeared round, the rim's edge darker, faint rings. Made once. */
let blurMap: THREE_NS.Texture | null = null;
function blurTexture(T: typeof THREE_NS): THREE_NS.Texture {
  if (blurMap) return blurMap;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  r.addColorStop(0, "rgba(40,40,44,0.95)");
  r.addColorStop(0.22, "rgba(70,72,78,0.9)");
  r.addColorStop(0.6, "rgba(112,115,122,0.82)");
  r.addColorStop(0.88, "rgba(80,82,88,0.88)");
  r.addColorStop(1, "rgba(40,40,44,0.95)");
  g.fillStyle = r;
  g.beginPath(); g.arc(64, 64, 64, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "rgba(170,173,180,0.25)";
  for (const rr of [24, 36, 47]) { g.lineWidth = 2; g.beginPath(); g.arc(64, 64, rr, 0, Math.PI * 2); g.stroke(); }
  blurMap = new T.CanvasTexture(c);
  blurMap.colorSpace = T.SRGBColorSpace;
  return blurMap;
}

/**
 * The wheels rolled on for [dt] seconds at [speedMps] on the ground — the car drawn [scale] times its size, so are its
 * tyres — and the front ones turned for a heading turning at [yawRate] radians a second (right positive): the angle a
 * car of this wheelbase would steer at that speed and turn, eased.
 */
export function rollWheels(w: Wheels, speedMps: number, yawRate: number, dt: number, scale = 1) {
  if (!(dt > 0)) return;
  const v = Math.max(0, speedMps);
  // Seen to turn with the speed, easing into MAX_STEP a frame (a frame no shorter than a sixtieth).
  const turn = (v / (WHEEL_RADIUS_M * Math.max(1, scale))) * dt;
  const most = MAX_STEP * Math.min(1, dt * 60);
  w.spin = (w.spin - most * Math.tanh(turn / most)) % (2 * Math.PI);
  const blur = BLUR_MAX * Math.max(0, Math.min(1, (v - BLUR_FROM) / (BLUR_FULL - BLUR_FROM)));
  for (const b of w.blurs) b.opacity = blur;
  const want = v > 1 ? Math.max(-MAX_STEER, Math.min(MAX_STEER, Math.atan((WHEELBASE_M * yawRate) / v))) : w.steer;
  w.steer += (want - w.steer) * (1 - Math.exp(-dt / STEER_EASE_S));
  for (const x of w.all) x.rotation.x = w.spin;
  // The model's front is −Z: a turn to the right is a negative turn about its up.
  for (const x of w.front) x.rotation.y = -w.steer;
}
