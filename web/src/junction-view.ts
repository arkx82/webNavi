import type * as THREE_NS from "three";
import type { Guide, LonLat } from "./types";
import type { Line } from "./geo";
import { findWheels, rollWheels, type Wheels } from "./car-wheels";

/**
 * 3D 분기점: before a junction a driver can get wrong, the junction as
 * 정밀도로지도 has it — the lanes at their heights (a ramp climbing over
 * the road below on its piers), their lines and painted arrows — drawn in
 * a panel at the top of the map, the route's lane in blue, the camera
 * following the car in. What the car apps show as a drawn picture, made
 * from the survey itself (server: junction3d.ts, /api/hdmap/junction).
 */
export type P3 = [number, number, number];
export interface Scene {
  centre: LonLat;
  links: P3[][];
  lines: { t: string; pts: P3[] }[];
  marks: { k: string; pts: P3[] }[];
  route: (P3 | null)[];
  matched: number;
}
type Three = typeof THREE_NS;

/** The car model's length to the Model Y L's (car-model.ts LENGTH_STRETCH). */
const MODEL_LENGTH_STRETCH = 4.976 / 4.78;
/** The route asked round the junction: this far before it and after, a point every STEP_M. */
const BEFORE_M = 450;
const AFTER_M = 400;
const STEP_M = 5;
/** The square of lanes asked about the junction. */
const RADIUS_M = 380;
/** The camera: behind the car, above it, looking on. */
const BACK_M = 30;
const UP_M = 12;
const AHEAD_M = 90;
/** Shown only where this share of the route round the junction lies on its lanes, with this many lanes and lines. */
const MATCHED_SHARE = 0.7;
const MIN_LANES = 25;
/** The camera's catching up: its time constant, seconds. */
const EASE_S = 0.1;
/** Frames a second at most (the car computer draws the map too). */
const FPS = 30;

interface Loaded { guide: Guide; scene: Scene; startAlong: number; route: P3[] }

export class JunctionView {
  private three: Three | null = null;
  private renderer: THREE_NS.WebGLRenderer | null = null;
  private world: THREE_NS.Scene | null = null;
  private camera: THREE_NS.PerspectiveCamera | null = null;
  private car: THREE_NS.Object3D | null = null;
  /** The 3D car (/api/car-model, the same Model Y the map draws), loaded once; null where there is none. */
  private model: THREE_NS.Object3D | null = null;
  private modelAsked = false;
  private modelPaints: THREE_NS.MeshStandardMaterial[] = [];
  /** The model's wheels, rolled by how fast the car goes along the route, steered by how its way turns. */
  private wheels: Wheels | null = null;
  private rolled: { at: number; s: number; yaw: number } | null = null;
  private paint = "#4f5459";
  /** Whether the server has the model (main.ts asks once); the plain box stands in where it has not. */
  modelUrl: string | null = null;
  private loaded: Loaded | null = null;
  private asked = new Map<Guide, Promise<void>>();
  private closed = new WeakSet<Guide>();
  private failed = new WeakSet<Guide>();
  private raf = 0;
  private lastDraw = 0;
  private along: () => number | null = () => null;
  private eye: P3 | null = null;
  private easedAt = 0;
  private look: P3 | null = null;
  /** The worker the triangles are made in (junction-worker.ts), and the answers awaited from it. */
  private worker: Worker | null = null;
  private noWorker = false;
  private asks = 0;
  private waiting = new Map<number, { resolve: (a: JunctionArrays) => void; reject: (e: Error) => void }>();

  constructor(private box: HTMLElement, private canvas: HTMLCanvasElement, private log: (m: string) => void) {
    box.querySelector<HTMLButtonElement>(".jv-close")?.addEventListener("click", () => {
      if (this.loaded) this.closed.add(this.loaded.guide);
      this.hide();
    });
  }

  /** The junction at [g] ([guideAlong] metres along [line]), fetched ahead of showing it. */
  prefetch(g: Guide, guideAlong: number, line: Line) {
    if (this.asked.has(g) || this.failed.has(g)) return;
    const startAlong = Math.max(0, guideAlong - BEFORE_M);
    const route: LonLat[] = [];
    for (let m = startAlong; m <= Math.min(line.lengthM, guideAlong + AFTER_M); m += STEP_M) route.push(line.place(m).at);
    const p = (async () => {
      try {
        const a = await fetch("/api/hdmap/junction", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ at: g.at, r: RADIUS_M, route }) });
        if (!a.ok) { this.failed.add(g); this.log(`3D 분기점 없음 · ${g.text} (${a.status})`); return; }
        const scene = (await a.json()) as Scene;
        const lifted = scene.route.filter((p): p is P3 => !!p);
        // Only where 정밀도로지도 has the junction: most of the route on its lanes, and lanes and lines enough round it
        // (황산 지하차도's four lanes drew a blue band over grass, 2026-10-14).
        if (scene.matched < scene.route.length * MATCHED_SHARE || scene.links.length < MIN_LANES || scene.lines.length < MIN_LANES || lifted.length < 20) {
          this.failed.add(g);
          this.log(`3D 분기점 정밀도로지도 모자람 · ${g.text} · 경로 ${scene.matched}/${scene.route.length} · 차로 ${scene.links.length} · 차선 ${scene.lines.length}`);
          return;
        }
        const route3 = scene.route.map((p, i) => p ?? lifted[Math.min(i, lifted.length - 1)]);
        // The triangles made off the page's thread (junction-worker.ts): made here they held the map up a tenth of a
        // second at a big junction, 400 m before it.
        const [arrays, three] = await Promise.all([this.shape(scene, route3), this.three ?? import("three")]);
        this.three = three;
        this.build({ guide: g, scene, startAlong, route: route3 }, arrays);
        this.log(`3D 분기점 준비 · ${g.text} · 차로 ${scene.links.length} · 차선 ${scene.lines.length}`);
      } catch (e) {
        this.failed.add(g);
        this.log(`3D 분기점 실패 · ${(e as Error).message}`);
      }
    })();
    this.asked.set(g, p);
  }

  /** Shown for [g] while [show] (the junction close and tricky); [along] reads the car's place each frame. */
  frame(g: Guide | null, show: boolean, along: () => number | null, sign: string, distText: string) {
    this.along = along;
    if (!g || !show || this.closed.has(g) || this.loaded?.guide !== g) { this.hide(); return; }
    this.box.querySelector(".jv-sign")!.textContent = sign;
    this.box.querySelector(".jv-dist")!.textContent = distText;
    if (this.box.hidden) {
      this.box.hidden = false;
      document.body.classList.add("jv-open");
      this.resize();
      this.eye = null;
      this.loop();
    }
  }

  get open() {
    return !this.box.hidden;
  }

  /** The car's paint (안내 설정 → 차 색). */
  setPaint(paint: string) {
    this.paint = paint;
    for (const m of this.modelPaints) m.color.set(paint);
  }

  /** The Model Y, once: the same file and the same Model Y L length the map's car is drawn at. */
  private async loadModel(): Promise<void> {
    if (this.modelAsked || !this.modelUrl || !this.three) return;
    this.modelAsked = true;
    try {
      const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
        import("three/examples/jsm/loaders/GLTFLoader.js"),
        import("three/examples/jsm/libs/meshopt_decoder.module.js"),
      ]);
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(this.modelUrl);
      gltf.scene.traverse((o) => {
        const mesh = o as THREE_NS.Mesh;
        if (!mesh.isMesh) return;
        const m = mesh.material as THREE_NS.MeshStandardMaterial;
        if (m.name === "paint") this.modelPaints.push(m);
      });
      gltf.scene.scale.set(1, 1, MODEL_LENGTH_STRETCH);
      this.model = gltf.scene;
      this.wheels = findWheels(gltf.scene);
      this.setPaint(this.paint);
      // Its shaders too, before it is drawn.
      if (this.renderer && this.camera) await this.renderer.compileAsync?.(gltf.scene, this.camera).catch(() => undefined);
      // Into the scene drawn now, in the box's place.
      if (this.world && this.car) {
        this.world.remove(this.car);
        this.car = this.model;
        this.world.add(this.car);
      }
    } catch (e) {
      this.log(`3D 분기점 자동차 모델 못 불러옴 · ${(e as Error).message}`);
    }
  }

  /** A new route: what was fetched for the old one goes. */
  reset() {
    this.hide();
    this.asked.clear();
    this.dispose();
  }

  private hide() {
    if (this.box.hidden) return;
    this.box.hidden = true;
    document.body.classList.remove("jv-open");
    cancelAnimationFrame(this.raf);
  }

  private resize() {
    if (!this.renderer || !this.camera) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (now - this.lastDraw < 1000 / FPS - 2) return;
    this.lastDraw = now;
    this.draw();
  };

  /** The route's point [m] metres from its start, between its 5 m steps. */
  private at(m: number): P3 {
    const r = this.loaded!.route;
    const x = Math.max(0, Math.min(r.length - 1.001, m / STEP_M));
    const i = Math.floor(x), t = x - i;
    return [0, 1, 2].map((k) => r[i][k] + t * (r[i + 1][k] - r[i][k])) as P3;
  }

  private draw() {
    const T = this.three, L = this.loaded;
    if (!T || !L || !this.renderer || !this.world || !this.camera) return;
    const along = this.along();
    if (along == null) return;
    const s = along - L.startAlong;
    const p = this.at(s), a = this.at(s - 2), b = this.at(s + 2), q = this.at(s + AHEAD_M);
    const dir = Math.atan2(q[0] - p[0], q[2] - p[2]);
    const eye: P3 = [p[0] - Math.sin(dir) * BACK_M, p[1] + UP_M, p[2] - Math.cos(dir) * BACK_M];
    // Eased over about a tenth of a second whatever the frame rate, so a jump of the car's place (a fix after a gap)
    // is not a jump of the picture; by the frame it was a share a frame, and a browser drawing four a second left the
    // camera 30 m further back than meant at motorway speed.
    const now = performance.now();
    const dt = this.easedAt ? Math.min(1, (now - this.easedAt) / 1000) : 1;
    this.easedAt = now;
    const k = this.eye ? 1 - Math.exp(-dt / EASE_S) : 1;
    this.eye = this.eye ? (this.eye.map((v, i) => v + (eye[i] - v) * k) as P3) : eye;
    this.look = this.look && k < 1 ? (this.look.map((v, i) => v + (q[i] - v) * k) as P3) : q;
    this.camera.position.set(...this.eye);
    this.camera.lookAt(...this.look);
    // The model's front is −Z (car-model.ts): turned so −Z runs the way the route goes; it stands on the road.
    const isModel = this.car === this.model;
    this.car!.position.set(p[0], p[1] + (isModel ? 0.05 : 0.8), p[2]);
    this.car!.rotation.y = isModel ? Math.atan2(-(b[0] - a[0]), -(b[2] - a[2])) : Math.atan2(b[0] - a[0], b[2] - a[2]);
    // The wheels: rolled by how far the car came since the last frame, the front ones steered by how its way turned
    // (a turn to the right is the car turning clockwise seen from above, negative about its up).
    if (isModel && this.wheels) {
      const yaw = this.car!.rotation.y;
      if (this.rolled) {
        const dt = Math.min(0.5, (now - this.rolled.at) / 1000);
        const turned = ((((yaw - this.rolled.yaw) * 180) / Math.PI % 360) + 540) % 360 - 180;
        if (dt > 0) rollWheels(this.wheels, Math.max(0, s - this.rolled.s) / dt, (-turned * Math.PI) / 180 / dt, dt);
      }
      this.rolled = { at: now, s, yaw };
    }
    this.renderer.render(this.world, this.camera);
  }

  private dispose() {
    this.world?.traverse((o) => {
      const m = o as THREE_NS.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE_NS.Material | THREE_NS.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
    });
    this.world = null;
    this.loaded = null;
  }

  /** The junction's triangles from the worker; made here where there is no worker to be had. */
  private shape(scene: Scene, route: P3[]): Promise<JunctionArrays> {
    try {
      if (!this.worker) {
        this.worker = new Worker(new URL("./junction-worker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = (e: MessageEvent<{ id: number; arrays?: JunctionArrays; error?: string }>) => {
          const w = this.waiting.get(e.data.id);
          this.waiting.delete(e.data.id);
          if (e.data.arrays) w?.resolve(e.data.arrays); else w?.reject(new Error(e.data.error ?? "worker"));
        };
        this.worker.onerror = (e) => {
          this.log(`3D 분기점 작업 스레드 오류 · ${e.message}`);
          for (const w of this.waiting.values()) w.reject(new Error(e.message));
          this.waiting.clear();
          this.worker?.terminate();
          this.worker = null;
          this.noWorker = true;
        };
      }
      if (this.noWorker) throw new Error("no worker");
      const id = ++this.asks;
      return new Promise<JunctionArrays>((resolve, reject) => {
        this.waiting.set(id, { resolve, reject });
        this.worker!.postMessage({ id, scene, route });
      }).catch(async () => junctionArrays(scene, route, this.three ?? (this.three = await import("three"))));
    } catch {
      return (async () => junctionArrays(scene, route, this.three ?? (this.three = await import("three"))))();
    }
  }

  private build(l: Loaded, arrays: JunctionArrays) {
    const T = this.three!;
    this.dispose();
    this.renderer ??= new T.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(1.5, devicePixelRatio || 1));
    this.camera ??= new T.PerspectiveCamera(55, 16 / 9, 1, 2500);
    const day = document.body.classList.contains("day");
    const world = new T.Scene();
    const sky = new T.Color(day ? 0xcfe2f2 : 0x1c2533);
    world.background = sky;
    world.fog = new T.Fog(sky, 220, 650);
    world.add(new T.HemisphereLight(0xffffff, day ? 0x6f7d66 : 0x222a33, day ? 1.6 : 0.9));
    const sun = new T.DirectionalLight(0xffffff, day ? 1.3 : 0.5);
    sun.position.set(-200, 400, 150);
    world.add(sun);
    const { scene } = l;
    const g = arrays;
    const ground = new T.Mesh(new T.PlaneGeometry(3000, 3000), new T.MeshLambertMaterial({ color: day ? 0xa9b89b : 0x2b3528 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = g.groundY;
    world.add(ground);
    // Each material's triangles as they came (the lit ones with their normals made already).
    const add = (a: Arrays | undefined, mat: THREE_NS.Material) => {
      if (!a || !a.idx.length) return;
      const geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.BufferAttribute(a.pos, 3));
      if (a.normal) geo.setAttribute("normal", new T.BufferAttribute(a.normal, 3));
      geo.setIndex(new T.BufferAttribute(a.idx, 1));
      world.add(new T.Mesh(geo, mat));
    };
    const p = g.parts;
    add(p.asphalt, new T.MeshLambertMaterial({ color: day ? 0x4d5463 : 0x3a404c, side: T.DoubleSide }));
    add(p.deck, new T.MeshLambertMaterial({ color: 0xc4c8ce, side: T.DoubleSide }));
    add(p.piers, new T.MeshLambertMaterial({ color: 0xb8bcc2 }));
    add(p.white, new T.MeshBasicMaterial({ color: 0xf2f2f2, side: T.DoubleSide }));
    add(p.yellow, new T.MeshBasicMaterial({ color: 0xf2c230, side: T.DoubleSide }));
    add(p.blue, new T.MeshBasicMaterial({ color: 0x3b82f6, side: T.DoubleSide }));
    add(p.band, new T.MeshBasicMaterial({ color: 0x2f7df6, transparent: true, opacity: 0.88, side: T.DoubleSide }));
    add(p.chevrons, new T.MeshBasicMaterial({ color: 0xffffff, side: T.DoubleSide }));
    // The Model Y where the server has it (the same as on the map), else a plain box until it comes.
    this.car = this.model ?? new T.Mesh(new T.BoxGeometry(1.9, 1.4, 4.6), new T.MeshLambertMaterial({ color: 0xffffff }));
    world.add(this.car);
    this.world = world;
    this.loaded = l;
    this.resize();
    // The shaders made ready now, off the page's thread where the browser can (KHR_parallel_shader_compile), not on
    // the first frame shown: done there they held the map up as the panel came. The car model after them.
    const ready = this.renderer.compileAsync?.(world, this.camera) ?? Promise.resolve();
    void ready.catch(() => undefined).then(() => this.loadModel());
  }

}

/** [r]'s point [m] metres along, between its STEP_M points. */
function atOf(r: P3[], m: number): P3 {
  const x = Math.max(0, Math.min(r.length - 1.001, m / STEP_M));
  const i = Math.floor(x), t = x - i;
  return [0, 1, 2].map((k) => r[i][k] + t * (r[i + 1][k] - r[i][k])) as P3;
}

/** The ground's cells, for the height under a ramp: a cell this wide, and a pier this often along a deck. */
const GROUND_CELL_M = 45;
const PIER_EVERY_M = 35;

/**
 * The junction's triangles, a set a material: the lanes as asphalt on their decks, piers where a deck stands high,
 * lines and painted marks, the route's band and chevrons — the work of the page's thread when a junction comes, kept
 * here apart from the drawing (and timed: junction-view.test.ts). [triangulate] is three's ShapeUtils, given.
 */
export function junctionGeometry(scene: Scene, route: P3[], triangulate: (pts: [number, number][]) => number[][]) {
  const asphalt = new Geo(), deck = new Geo(), piers = new Geo(), white = new Geo(), yellow = new Geo(), blue = new Geo(), band = new Geo(), chevrons = new Geo();
  let minY = Infinity;
  for (const link of scene.links) for (const p of link) if (p[1] < minY) minY = p[1];
  // The lowest road about each point, for where a pier stands: every third point of the lanes, by cells (each point
  // against every road point had 상일IC's twelve thousand against four thousand — a tenth of a second on a desk).
  const cells = new Map<string, number>();
  const cellOf = (x: number, z: number) => `${Math.floor(x / GROUND_CELL_M)},${Math.floor(z / GROUND_CELL_M)}`;
  for (const link of scene.links) for (let i = 0; i < link.length; i += 3) {
    const p = link[i], key = cellOf(p[0], p[2]);
    const had = cells.get(key);
    if (had == null || p[1] < had) cells.set(key, p[1]);
  }
  const groundAt = (x: number, z: number) => {
    let g = Infinity;
    const cx = Math.floor(x / GROUND_CELL_M), cz = Math.floor(z / GROUND_CELL_M);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const v = cells.get(`${cx + dx},${cz + dz}`);
      if (v != null && v < g) g = v;
    }
    return Math.min(g, minY + 30) - 0.2;
  };
  for (const link of scene.links) {
    asphalt.ribbon(link, 3.7, 0);
    deck.ribbon(link.map((p) => [p[0], p[1] - 0.6, p[2]] as P3), 3.9, 0);
    let along = 0;
    for (let i = 0; i < link.length; i++) {
      const p = link[i];
      if (i) along += Math.hypot(p[0] - link[i - 1][0], p[2] - link[i - 1][2]);
      // The ground asked only where a pier may stand.
      if (along % PIER_EVERY_M >= 4) continue;
      const g = groundAt(p[0], p[2]);
      if (p[1] - g > 4) piers.box(p[0], g, p[2], 1.6, p[1] - 0.6 - g);
    }
  }
  for (const ln of scene.lines) {
    const into = ln.t.startsWith("1") ? yellow : ln.t.startsWith("3") ? blue : white;
    const dense = densify(ln.pts);
    if (!ln.t.endsWith("2")) { into.ribbon(dense, 0.18, 0.04); continue; }
    let run: P3[] = [], acc = 0;
    for (let i = 0; i < dense.length; i++) {
      if (i) acc += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][2] - dense[i - 1][2]);
      if (acc % 9 < 3) run.push(dense[i]);
      else { if (run.length > 1) into.ribbon(run, 0.18, 0.04); run = []; }
    }
    if (run.length > 1) into.ribbon(run, 0.18, 0.04);
  }
  for (const mk of scene.marks) {
    try {
      white.polygon(mk.pts, triangulate(mk.pts.map((p) => [p[0], p[2]])), 0.05);
    } catch { /* a ring that does not triangulate is left out */ }
  }
  band.ribbon(route, 3.0, 0.08);
  for (let m = 10; m < (route.length - 1) * STEP_M; m += 14) {
    const a = atOf(route, m - 1), b = atOf(route, m + 1);
    chevrons.chevron(b, Math.atan2(b[0] - a[0], b[2] - a[2]));
  }
  return { asphalt, deck, piers, white, yellow, blue, band, chevrons, groundY: minY - 0.5 };
}

/** One material's triangles as arrays: positions, indices, and normals where it is lit. */
export interface Arrays { pos: Float32Array; idx: Uint16Array | Uint32Array; normal: Float32Array | null }
export interface JunctionArrays { parts: Record<string, Arrays>; groundY: number }
/** The parts that are lit (and want normals); the rest are flat colour. */
const LIT = new Set(["asphalt", "deck", "piers"]);

/** [junctionGeometry] as arrays to hand over (from the worker, transferred): three [T] for the triangulation and the normals. */
export function junctionArrays(scene: Scene, route: P3[], T: Three): JunctionArrays {
  const g = junctionGeometry(scene, route, (pts) => T.ShapeUtils.triangulateShape(pts.map(([x, z]) => new T.Vector2(x, z)), []));
  const parts: Record<string, Arrays> = {};
  for (const [name, geo] of Object.entries(g)) {
    if (!(geo instanceof Geo) || !geo.size) continue;
    const b = geo.geometry(T, LIT.has(name));
    parts[name] = {
      pos: b.getAttribute("position").array as Float32Array,
      idx: b.getIndex()!.array as Uint16Array | Uint32Array,
      normal: LIT.has(name) ? (b.getAttribute("normal").array as Float32Array) : null,
    };
  }
  return { parts, groundY: g.groundY };
}

/** [pts] with a point every metre, so a dash is a dash wherever the survey put its points. */
function densify(pts: P3[]): P3[] {
  const out: P3[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2])));
    for (let k = 1; k <= n; k++) out.push([a[0] + (k / n) * (b[0] - a[0]), a[1] + (k / n) * (b[1] - a[1]), a[2] + (k / n) * (b[2] - a[2])]);
  }
  return out;
}

/** Triangles gathered for one mesh. */
export class Geo {
  private pos: number[] = [];
  private idx: number[] = [];
  get size() { return this.idx.length; }
  /** A strip [width] wide along [pts], [lift] above them. */
  ribbon(pts: P3[], width: number, lift: number) {
    const base = this.pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[2] - a[2];
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      const nx = (-dz * width) / 2, nz = (dx * width) / 2, p = pts[i];
      this.pos.push(p[0] + nx, p[1] + lift, p[2] + nz, p[0] - nx, p[1] + lift, p[2] - nz);
      if (i) { const k = base + i * 2; this.idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    }
  }
  /** An outline already triangulated (its triangles as indices into [pts]). */
  polygon(pts: P3[], tris: number[][], lift: number) {
    const base = this.pos.length / 3;
    for (const p of pts) this.pos.push(p[0], p[1] + lift, p[2]);
    for (const t of tris) this.idx.push(base + t[0], base + t[1], base + t[2]);
  }
  /** A square post [side] wide from [y] up [h]. */
  box(x: number, y: number, z: number, side: number, h: number) {
    if (h <= 0) return;
    const s = side / 2, base = this.pos.length / 3;
    for (const [dx, dz] of [[-s, -s], [s, -s], [s, s], [-s, s]]) this.pos.push(x + dx, y, z + dz, x + dx, y + h, z + dz);
    for (let f = 0; f < 4; f++) {
      const a = base + f * 2, b = base + ((f + 1) % 4) * 2;
      this.idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  /** A chevron flat on the road at [p], pointing [ang]. */
  chevron(p: P3, ang: number) {
    const shape: [number, number][] = [[-1.1, -0.6], [0, 0.6], [1.1, -0.6], [0.6, -0.6], [0, 0], [-0.6, -0.6]];
    const base = this.pos.length / 3, c = Math.cos(ang), s = Math.sin(ang);
    for (const [x, y] of shape) this.pos.push(p[0] + x * c + y * s, p[1] + 0.12, p[2] - x * s + y * c);
    for (const t of [[0, 1, 4], [0, 4, 5], [4, 1, 2], [4, 2, 3]]) this.idx.push(base + t[0], base + t[1], base + t[2]);
  }
  /** As three's geometry; with normals where it is to be lit ([lit]). */
  geometry(T: Three, lit = true): THREE_NS.BufferGeometry {
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(this.pos, 3));
    g.setIndex(this.pos.length / 3 > 65535 ? new T.Uint32BufferAttribute(this.idx, 1) : new T.Uint16BufferAttribute(this.idx, 1));
    if (lit) g.computeVertexNormals();
    return g;
  }
}
