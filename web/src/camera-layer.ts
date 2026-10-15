import type maplibregl from "maplibre-gl";
import { metres } from "./geo";
import { flashingNow, type Feature, type Kind } from "./warnings";
import type { LonLat } from "./types";

/**
 * Enforcement cameras on the map, the way the car apps draw them: a limit
 * sign where the camera holds one (yellow in a school zone), a traffic
 * light for a signal camera, the start and end of a 구간 단속. Asked of the
 * server round the map's middle, not only along a route, so a camera can
 * be seen before a drive; drawn by the map itself like the 주변 pins
 * (pin-layer.ts), so they do not swim while the camera follows the car.
 */
const KINDS: Kind[] = ["speed", "signal", "speed-signal", "section-start", "section-end", "school", "signal-light"];
/** Traffic lights are many: drawn only this close, and small. */
export const LIGHTS_MIN_ZOOM = 15;
/** Asked again when the middle has moved this far from where it was last asked, or this long has passed. */
export const ASK_AGAIN_M = 800;
export const ASK_AGAIN_MS = 5 * 60_000;
/** How often the middle is looked at: following the car, jumpTo fires moveend every frame, so no event is waited for. */
const CHECK_MS = 2000;
const RADIUS_M = 3000;
/** Kept this far from the middle; further ones are dropped. */
const KEEP_M = 6000;
export const CAMERAS_MIN_ZOOM = 12;
/** Cameras and lights held at most; past it the furthest from the map go. */
const KEPT_MAX = 6000;

export class CameraLayer {
  private ready = false;
  private known = new Map<string, Feature>();
  private askedAt: LonLat | null = null;
  private askedWhen = 0;
  private asking = false;
  private installing = false;

  constructor(private map: maplibregl.Map, private wanted: (f: Feature, ahead: Set<string> | null) => boolean, private log: (text: string) => void) {
    map.on("style.load", () => {
      this.ready = false;
      void this.install();
    });
    // A limit sign is made the first time the map asks for it (sign:limit:60, sign:school:30, sign:end:해제): drawn on
    // a canvas there and then, the number part of the picture.
    map.on("styleimagemissing", (e: { id: string }) => {
      const [what, kind, label] = e.id.split(":");
      if (what !== "sign" || !label || this.map.hasImage(e.id)) return;
      const image = limitSign(kind as SignKind, label);
      if (image) this.map.addImage(e.id, image, { pixelRatio: SIGN_RATIO });
    });
    // Made after the style came, or the style not done at the time: the next quiet moment tries again.
    map.on("idle", () => { if (!this.ready) void this.install(); });
    window.setInterval(() => void this.ask(), CHECK_MS);
    if (map.isStyleLoaded()) void this.install();
  }

  /** The driver's settings changed: what is shown follows them. */
  redraw() {
    if (this.ready) this.fill();
  }

  /** The traffic lights on the route ahead, for the map to show only those; null when not driving. */
  private lightsAhead: Set<string> | null = null;
  setLightsAhead(ids: Set<string> | null) {
    const same = ids === this.lightsAhead || (!!ids && !!this.lightsAhead && ids.size === this.lightsAhead.size && [...ids].every((id) => this.lightsAhead!.has(id)));
    this.lightsAhead = ids;
    if (!same && this.ready) this.fill();
  }
  /** The camera the car comes to next on the route: drawn large, with a red ring, so where it is can be seen. */
  private nextCamera: string | null = null;
  setNextCamera(id: string | null) {
    if (id === this.nextCamera) return;
    this.nextCamera = id;
    if (this.ready) this.fill();
  }

  /**
   * The cameras in front of the car on the road it is on, of those the map knows: within [reachM] ahead, within
   * ±30° of its heading, and not the other way's (every carriageway they stand on running against it). For the car
   * off its route — leaving the car park the other way, a wrong turn — whose road the route watch does not cover:
   * on 2026-10-04 two 어린이 보호구역 cameras on 언주로 went undrawn for the half-minute the car was off the route.
   */
  ahead(at: LonLat, headingDeg: number, reachM = 600): Feature[] {
    const kx = 111_320 * Math.cos((at[1] * Math.PI) / 180), ky = 111_320;
    const off = (a: number, b: number) => Math.abs(((b - a + 540) % 360) - 180);
    return [...this.known.values()].filter((f) => {
      if (f.kind === "signal-light") return false;
      const dx = (f.lon - at[0]) * kx, dy = (f.lat - at[1]) * ky, d = Math.hypot(dx, dy);
      if (d > reachM || d < 5) return false;
      if (off(headingDeg, ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360) > 30) return false;
      return !(f.ways?.length && f.ways.every((w) => w.deg >= 0 && off(headingDeg, w.deg) >= 110));
    });
  }

  /** Features the route watch placed, so a light ahead is drawn even before the map's own ask has it. */
  addKnown(features: Feature[]) {
    for (const f of features) if (KINDS.includes(f.kind)) this.known.set(f.id, f);
    this.trim();
  }

  /** How many it holds (the 진단 log's minute line). */
  get size() { return this.known.size; }

  /** Kept to the ones near where the map is: a long drive asked round every stretch, and kept them all. */
  private trim() {
    if (this.known.size <= KEPT_MAX) return;
    const c = this.map.getCenter();
    const far = [...this.known.values()]
      .map((f) => ({ f, d: Math.hypot((f.lon - c.lng) * Math.cos((c.lat * Math.PI) / 180), f.lat - c.lat) }))
      .sort((a, b) => b.d - a.d);
    for (const { f } of far.slice(0, this.known.size - KEPT_MAX * 0.7)) this.known.delete(f.id);
  }

  private async ask() {
    if (this.asking) return;
    const c = this.map.getCenter();
    const at: LonLat = [c.lng, c.lat];
    if (!shouldAsk({ askedAt: this.askedAt, askedWhen: this.askedWhen, at, zoom: this.map.getZoom() })) return;
    this.asking = true;
    try {
      const a = await fetch(`/api/safety/near?lon=${at[0]}&lat=${at[1]}&r=${RADIUS_M}`);
      if (!a.ok) throw new Error(`${a.status}`);
      const found = (await a.json()) as Feature[];
      this.askedAt = at;
      this.askedWhen = Date.now();
      for (const f of found) if (KINDS.includes(f.kind)) this.known.set(f.id, f);
      this.trim();
      for (const [id, f] of this.known) if (metres(at[0], at[1], f.lon, f.lat) > KEEP_M) this.known.delete(id);
      if (this.ready) this.fill();
    } catch (e) {
      this.log(`카메라 지도 실패 ${(e as Error).message}`);
    } finally {
      this.asking = false;
    }
  }

  private async install() {
    if (this.ready || this.installing) return;
    this.installing = true;
    try {
      // Each icon on its own: one that fails to decode is left out (its cameras draw without a sign), the rest still come.
      await Promise.all([
        this.image("cam-signal", signal()),
        this.image("cam-camera", camera()),
        this.image("light", lamp("#33343a")),
        this.image("light-flash", lamp("#ffb020")),
      ]);
      if (!this.ready && !this.map.getSource("cams")) this.layers();
    } catch (e) {
      // The style not done yet (a new ground just set): the next idle tries again.
      this.log(`카메라 지도 준비 실패 ${(e as Error).message}`);
    } finally {
      this.installing = false;
    }
  }

  private layers() {
    this.map.addSource("cams", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    // Under the 주변 pins when they are there: a place tapped is the thing looked for.
    const before = this.map.getLayer("pins-label") ? "pins-label" : undefined;
    this.map.addLayer({
      id: "lights", type: "symbol", source: "cams", minzoom: LIGHTS_MIN_ZOOM, filter: ["==", ["get", "light"], true],
      layout: {
        "icon-image": ["get", "icon"],
        "icon-size": ["interpolate", ["exponential", 1.6], ["zoom"], 14, 0.3, 16, 0.55, 18, 0.85],
        "icon-allow-overlap": true,
        // Standing up on the road, facing the driver, as a signal head does — not lying flat on it, which in the tilted
        // view read as painted on the asphalt (2026-10-11). Raised by half its height so its foot is at its place.
        "icon-pitch-alignment": "viewport",
        "icon-offset": [0, -10],
      },
    }, before);
    // The next camera: a red ring on the road round it, beneath its sign.
    this.map.addLayer({
      id: "cams-next", type: "circle", source: "cams", minzoom: CAMERAS_MIN_ZOOM, filter: ["==", ["get", "next"], true],
      paint: {
        "circle-radius": ["interpolate", ["exponential", 1.6], ["zoom"], 12, 8, 16, 22, 18, 34],
        "circle-color": "rgba(229, 72, 77, 0.22)",
        "circle-stroke-color": "#e5484d",
        "circle-stroke-width": 3,
        "circle-pitch-alignment": "map",
      },
    }, before);
    this.map.addLayer({
      id: "cams", type: "symbol", source: "cams", minzoom: CAMERAS_MIN_ZOOM, filter: ["!=", ["get", "light"], true],
      layout: {
        "icon-image": ["get", "icon"],
        // Small as the map draws back, full size close in: a sign the size of a street block at zoom 13 looked adrift.
        // The zoom curve must be the outermost expression (MapLibre drops the layer otherwise); the next one's goes in each stop.
        // The next camera's sign about 42 css px at zoom 16 and the others 31 — read at a glance, as NAVER's cluster
        // draws its 60 (2026-10-15); before, 24 px with the number a small label laid over it.
        "icon-size": ["interpolate", ["exponential", 1.6], ["zoom"], ...[[12, 0.35], [14, 0.5], [16, 0.7], [18, 0.85]].flatMap(([z, s]) => [z, ["*", ["case", ["get", "next"], NEXT_SCALE, 1], s]])] as maplibregl.ExpressionSpecification,
        // Standing on its place facing the driver, as the car apps draw a camera sign (2026-10-11: flat on the road it
        // read as painted on): its foot — a limit sign's point — at its place.
        "icon-pitch-alignment": "viewport",
        "icon-anchor": "bottom",
        "icon-allow-overlap": true,
        "symbol-sort-key": ["get", "z"],
      },
    }, before);
    this.ready = true;
    this.fill();
  }

  private fill() {
    const features = [...this.known.values()].filter((f) => this.wanted(f, this.lightsAhead)).map((f) => {
      const { icon } = look(f);
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [f.lon, f.lat] },
        properties: { id: f.id, icon, z: f.id === this.nextCamera ? 3 : f.kind === "school" ? 2 : 1, light: f.kind === "signal-light", next: f.id === this.nextCamera },
      };
    });
    (this.map.getSource("cams") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
  }

  private async image(name: string, svg: string) {
    if (this.map.hasImage(name)) return;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    try {
      await img.decode();
      if (!this.map.hasImage(name)) this.map.addImage(name, img, { pixelRatio: 2 });
    } catch (e) {
      this.log(`카메라 아이콘 ${name} 실패 ${(e as Error).message}`);
    }
  }
}

/**
 * Whether the server is asked for the cameras round [at] now: not drawn back
 * too far to show any; and either never asked, moved ASK_AGAIN_M from where
 * it was last asked, or asked longer ago than ASK_AGAIN_MS.
 */
export function shouldAsk(s: { askedAt: LonLat | null; askedWhen: number; at: LonLat; zoom: number }, now = Date.now()): boolean {
  if (s.zoom < CAMERAS_MIN_ZOOM - 0.5) return false;
  if (!s.askedAt) return true;
  if (now - s.askedWhen >= ASK_AGAIN_MS) return true;
  return metres(s.askedAt[0], s.askedAt[1], s.at[0], s.at[1]) >= ASK_AGAIN_M;
}

/** Which icon a camera is drawn with: a limit sign names its kind and number (made on demand, limitSign). */
export function look(f: Pick<Feature, "kind" | "limit" | "flash">, now = Date.now()): { icon: string } {
  const limit = f.limit && f.limit > 0 && f.limit < 1000 ? String(Math.round(f.limit)) : null;
  switch (f.kind) {
    case "signal-light": return { icon: flashingNow(f, now) ? "light-flash" : "light" };
    case "signal": return { icon: "cam-signal" };
    case "section-end": return { icon: "sign:end:해제" };
    case "school": return { icon: limit ? `sign:school:${limit}` : "cam-camera" };
    default: return { icon: limit ? `sign:limit:${limit}` : "cam-camera" };
  }
}

/** The next camera's sign this many times the others'. */
const NEXT_SCALE = 1.35;
/** Signs are drawn at twice their css size. */
const SIGN_RATIO = 2;
type SignKind = "limit" | "school" | "end";
const SIGN_LOOK: Record<SignKind, { ring: string; face: string }> = {
  limit: { ring: "#e5484d", face: "#ffffff" },
  school: { ring: "#e5484d", face: "#ffd60a" },
  end: { ring: "#8a8f99", face: "#ffffff" },
};

/**
 * A camera's limit sign, 44 × 52 css px: a red ring round a white face (yellow in a school zone, grey ring for the
 * end of a 구간 단속), the number bold on it, a small camera at its shoulder, and a point under it on the camera's
 * place. Null where there is no canvas (a test).
 */
function limitSign(kind: SignKind, label: string): ImageData | null {
  const look = SIGN_LOOK[kind];
  if (!look || typeof document === "undefined") return null;
  const w = 88, h = 104, cx = 44, cy = 44;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) return null;
  // The point, then the sign over it, with a soft shadow to stand off the map by day and night.
  g.shadowColor = "rgba(0, 0, 0, 0.45)";
  g.shadowBlur = 5;
  g.shadowOffsetY = 1.5;
  g.fillStyle = look.ring;
  g.beginPath(); g.moveTo(cx - 11, 78); g.lineTo(cx + 11, 78); g.lineTo(cx, 101); g.closePath(); g.fill();
  g.beginPath(); g.arc(cx, cy, 41, 0, Math.PI * 2); g.fill();
  g.shadowColor = "transparent";
  g.fillStyle = look.face;
  g.beginPath(); g.arc(cx, cy, 31, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#111111";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const size = label.length >= 3 || !/^\d+$/.test(label) ? 26 : 36;
  g.font = `800 ${size}px "Noto Sans KR", "Noto Sans", Arial, sans-serif`;
  g.fillText(label, cx, cy + 2, 56);
  // The camera at the top right of the ring.
  g.fillStyle = "#1c1c20";
  g.strokeStyle = "#ffffff";
  g.lineWidth = 2.5;
  g.beginPath(); g.roundRect(59, 1, 27, 18, 4); g.fill(); g.stroke();
  g.fillStyle = "#ffffff";
  g.beginPath(); g.arc(72.5, 10, 4.5, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#1c1c20";
  g.beginPath(); g.arc(72.5, 10, 2, 0, Math.PI * 2); g.fill();
  return g.getImageData(0, 0, w, h);
}

/** A small traffic-light head, 40 px (20 css px): dark, or amber while it flashes. */
function lamp(body: string): string {
  const lit = body === "#ffb020";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">` +
    `<rect x="4" y="12" width="32" height="16" rx="5" fill="${body}" stroke="#fff" stroke-width="2.5"/>` +
    `<circle cx="12" cy="20" r="3.6" fill="${lit ? "#5a3b00" : "#ff4d4f"}"/><circle cx="20" cy="20" r="3.6" fill="${lit ? "#fff3c4" : "#ffb020"}"/><circle cx="28" cy="20" r="3.6" fill="${lit ? "#5a3b00" : "#12b76a"}"/></svg>`;
}

function signal(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60">` +
    `<circle cx="30" cy="30" r="27" fill="#1c1c20" stroke="#e5484d" stroke-width="5"/>` +
    `<rect x="21" y="12" width="18" height="36" rx="6" fill="#33343a"/>` +
    `<circle cx="30" cy="20" r="4.5" fill="#ff4d4f"/><circle cx="30" cy="30" r="4.5" fill="#ffb020"/><circle cx="30" cy="40" r="4.5" fill="#12b76a"/></svg>`;
}

function camera(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60">` +
    `<circle cx="30" cy="30" r="27" fill="#ffffff" stroke="#e5484d" stroke-width="5"/>` +
    `<rect x="15" y="22" width="24" height="16" rx="3" fill="#111"/><path d="M39 26l8-4v16l-8-4z" fill="#111"/><circle cx="25" cy="30" r="4" fill="#fff"/></svg>`;
}
