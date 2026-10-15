import maplibregl from "maplibre-gl";
import type * as THREE_NS from "three";
import type { LonLat } from "./types";
import { findWheels, rollWheels, type Wheels } from "./car-wheels";

/**
 * "You" on the map as a model in three dimensions: a Model Y (the owner's download from Sketchfab, by BloxBloger,
 * CC BY-NC 4.0 — kept in CONFIG_DIR, never in the repository, served at /api/car-model after tools/car-model made it
 * small: up +Y, front −Z, its footprint's middle on the ground at the origin, the body's material named "paint").
 *
 * A MapLibre custom layer drawing with three.js into the map's own WebGL context, after the buildings and with the
 * same depth buffer, so the car stands in the tilted view as the buildings do and is hidden behind them as a car is.
 * three.js is loaded only when this is chosen (안내 설정 → 자차 모양 → 3D); the drawing at the car's lane-wide size
 * is the image's rule (car-icon.ts carScale), and the map is asked to draw again only when the car moved.
 */
export const MODEL_CREDIT = "3D 모델: BloxBloger · Sketchfab (CC BY-NC 4.0)";
/** The model's widest part, mirror to mirror, and its length, metres (the made-small file's bounds). */
export const MODEL_WIDTH_M = 2.12;
const MODEL_LENGTH_M = 4.78;
/** The car it stands for is a Model Y L: longer than the model by this. */
const LENGTH_STRETCH = 4.976 / MODEL_LENGTH_M;

type Three = typeof THREE_NS;


export class CarModelLayer implements maplibregl.CustomLayerInterface {
  readonly id = "car-model";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  /** Whether the model is in and drawn; false while it loads, and for good when it could not be had. */
  ready = false;
  failed = false;
  private three: Three | null = null;
  private renderer: THREE_NS.WebGLRenderer | null = null;
  private scene: THREE_NS.Scene | null = null;
  private camera: THREE_NS.Camera | null = null;
  private paints: THREE_NS.MeshStandardMaterial[] = [];
  private paint = "#4f5459";
  private at: LonLat | null = null;
  private heading = 0;
  private scale = 1;
  /** The wheels to roll, the speed and the heading's turning to roll and steer them by, and when they were last rolled. */
  private wheels: Wheels | null = null;
  private speed = 0;
  private yawRate = 0;
  private placedAt = 0;
  private rolledAt = 0;
  shown = true;

  constructor(private url: string, private onFailed: (why: string) => void = () => {}, private onReady: () => void = () => {}) {}

  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    void this.load(map, gl).catch((e) => {
      this.failed = true;
      this.onFailed((e as Error)?.message ?? String(e));
    });
  }

  private async load(map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    const [THREE, { GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
      import("three"),
      import("three/examples/jsm/loaders/GLTFLoader.js"),
      import("three/examples/jsm/libs/meshopt_decoder.module.js"),
    ]);
    this.three = THREE;
    const scene = new THREE.Scene();
    // Sky above, the road's grey below, and the sun high on the car's left-behind: the body reads in the tilted view.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x77736c, 1.7));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(-3, 8, 4);
    scene.add(sun);
    // A soft shadow under it: a car with none floats over the road.
    scene.add(this.shadow(THREE));
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(this.url);
    gltf.scene.traverse((o) => {
      const mesh = o as THREE_NS.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE_NS.MeshStandardMaterial;
      if (m.name === "paint") this.paints.push(m);
    });
    // The Model Y L's length; its width and height as the model's.
    gltf.scene.scale.set(1, 1, LENGTH_STRETCH);
    this.wheels = findWheels(gltf.scene);
    scene.add(gltf.scene);
    this.scene = scene;
    this.camera = new THREE.Camera();
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    this.setPaint(this.paint);
    this.ready = true;
    this.onReady();
    map.triggerRepaint();
  }

  /** A soft dark ellipse on the ground under the car, from a radial gradient. */
  private shadow(THREE: Three): THREE_NS.Mesh {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const r = g.createRadialGradient(32, 32, 4, 32, 32, 32);
    r.addColorStop(0, "rgba(0,0,0,0.55)");
    r.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(MODEL_WIDTH_M * 1.25, MODEL_LENGTH_M * LENGTH_STRETCH * 1.15),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0.02;
    return plane;
  }

  setPaint(paint: string) {
    this.paint = paint;
    for (const m of this.paints) m.color.set(paint);
  }

  /**
   * Where the car is, the way it faces (degrees clockwise from north), how many times its true size it is drawn, and
   * how fast it goes: the wheels roll by it, and the front ones turn by how fast the heading turns.
   */
  place(at: LonLat, headingDeg: number, scale: number, speedMps = 0) {
    const now = performance.now();
    if (this.placedAt) {
      const dt = (now - this.placedAt) / 1000;
      const turned = ((((headingDeg - this.heading) % 360) + 540) % 360) - 180;
      if (dt > 0 && dt < 1) this.yawRate += ((turned * Math.PI) / 180 / dt - this.yawRate) * Math.min(1, dt / 0.3);
    }
    this.placedAt = now;
    this.at = at;
    this.heading = headingDeg;
    this.scale = scale;
    this.speed = speedMps;
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: maplibregl.CustomRenderMethodInput) {
    const THREE = this.three;
    if (!this.ready || !THREE || !this.renderer || !this.scene || !this.camera || !this.at || !this.shown) return;
    const origin = maplibregl.MercatorCoordinate.fromLngLat({ lng: this.at[0], lat: this.at[1] }, 0);
    const s = origin.meterInMercatorCoordinateUnits() * this.scale;
    // The wheels rolled on since the last frame drawn (none drawn while the car stands: nothing moves then).
    const now = performance.now();
    if (this.wheels && this.rolledAt) rollWheels(this.wheels, this.speed, this.yawRate, Math.min(0.2, (now - this.rolledAt) / 1000), this.scale);
    this.rolledAt = now;
    // Model space (X across, Y up, Z along with the front at −Z) into the map's: up turned onto the map's up (its
    // mercator y runs south, hence the flip), then turned to face the heading, clockwise from north.
    const toMap = new THREE.Matrix4()
      .makeTranslation(origin.x, origin.y, origin.z)
      .scale(new THREE.Vector3(s, -s, s))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
      .multiply(new THREE.Matrix4().makeRotationY((-this.heading * Math.PI) / 180));
    this.camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]).multiply(toMap);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  onRemove() {
    this.renderer?.dispose();
    this.renderer = null;
    this.ready = false;
  }
}
