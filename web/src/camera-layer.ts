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

  /** Features the route watch placed, so a light ahead is drawn even before the map's own ask has it. */
  addKnown(features: Feature[]) {
    for (const f of features) if (KINDS.includes(f.kind)) this.known.set(f.id, f);
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
        this.image("cam-limit", sign("#e5484d", "#ffffff")),
        this.image("cam-school", sign("#e5484d", "#ffd60a")),
        this.image("cam-signal", signal()),
        this.image("cam-camera", camera()),
        this.image("cam-end", sign("#8a8f99", "#ffffff")),
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
        // On the road, not standing up off it: far ones smaller in the tilted view, as the road is.
        "icon-pitch-alignment": "map",
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
        "icon-size": ["*", ["case", ["get", "next"], 1.5, 1], ["interpolate", ["exponential", 1.6], ["zoom"], 12, 0.35, 14, 0.55, 16, 0.8, 18, 1]],
        "icon-pitch-alignment": "map",
        "text-pitch-alignment": "map",
        "icon-allow-overlap": true,
        "text-allow-overlap": true,
        "text-field": ["get", "text"],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["exponential", 1.6], ["zoom"], 12, 5, 14, 7.5, 16, 11, 18, 13],
        "symbol-sort-key": ["get", "z"],
      },
      paint: { "text-color": "#111111" },
    }, before);
    this.ready = true;
    this.fill();
  }

  private fill() {
    const features = [...this.known.values()].filter((f) => this.wanted(f, this.lightsAhead)).map((f) => {
      const { icon, text } = look(f);
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [f.lon, f.lat] },
        properties: { id: f.id, icon, text, z: f.id === this.nextCamera ? 3 : f.kind === "school" ? 2 : 1, light: f.kind === "signal-light", next: f.id === this.nextCamera },
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

/** Which icon a camera is drawn with, and the number on it. */
export function look(f: Pick<Feature, "kind" | "limit" | "flash">, now = Date.now()): { icon: string; text: string } {
  switch (f.kind) {
    case "signal-light": return { icon: flashingNow(f, now) ? "light-flash" : "light", text: "" };
    case "signal": return { icon: "cam-signal", text: "" };
    case "section-end": return { icon: "cam-end", text: "해제" };
    case "school": return f.limit ? { icon: "cam-school", text: String(f.limit) } : { icon: "cam-camera", text: "" };
    case "section-start": return f.limit ? { icon: "cam-limit", text: String(f.limit) } : { icon: "cam-camera", text: "" };
    default: return f.limit ? { icon: "cam-limit", text: String(f.limit) } : { icon: "cam-camera", text: "" };
  }
}

/** A 60 px limit sign (30 css px): the ring's colour, the face's. */
function sign(ring: string, face: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60">` +
    `<circle cx="30" cy="30" r="26" fill="${face}" stroke="${ring}" stroke-width="7"/>` +
    `<circle cx="30" cy="30" r="29" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="1.5"/></svg>`;
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
