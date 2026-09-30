import type maplibregl from "maplibre-gl";

/**
 * TMAP's own vector map as the ground under the MapLibre map: Korean
 * roads as TMAP has them — apartment entrances, alleys, new roads — while
 * everything the app draws (route, pins, the car) and every gesture stays
 * on MapLibre, whose canvas is then transparent above it.
 *
 * The two cameras agree to under half a pixel at the same centre, zoom,
 * pitch and bearing (both are Web Mercator on 512 px tiles with the same
 * field of view; measured at 0–60° of tilt). TMAP ignores camera padding,
 * so the app follows the car by moving the centre, never by padding, and
 * this layer copies MapLibre's camera on every move.
 *
 * The SDK comes from /api/map/tmap.js, a blocking script in the page head
 * that document.writes TMAP's loader; without a key there is no Tmapv3 and
 * the app keeps its OpenStreetMap ground.
 */
interface TmapCamera {
  jumpTo(options: { center: [number, number]; zoom: number; bearing: number; pitch: number }): void;
  setMaxPitch?(pitch: number): void;
}
interface TmapMap {
  vsmMap(): { getCamera(): TmapCamera; resize(): void };
  setInteractive(on: boolean): void;
  destroy(): void;
}
declare global {
  interface Window {
    Tmapv3?: {
      Map: new (div: string | HTMLElement, options: Record<string, unknown>) => TmapMap;
      LatLng: new (lat: number, lng: number) => unknown;
    };
  }
}

/** The MapLibre style when TMAP draws the ground: nothing but the fonts the pins' labels use. */
export const OVERLAY_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {},
  layers: [],
};

export function tmapAvailable(): boolean {
  return typeof window.Tmapv3?.Map === "function";
}

export class TmapBase {
  private tmap: TmapMap;
  private camera: TmapCamera;
  /** One copy a frame: the frame loop moves the map more than once, and each move redrew this map too. */
  private pending = false;
  private readonly sync = () => {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => { this.pending = false; this.copy(); });
  };
  private readonly fit = () => this.tmap.vsmMap().resize();

  constructor(private box: HTMLElement, private map: maplibregl.Map) {
    // Shown first: a map made inside a hidden box measures 0×0 and never draws.
    box.hidden = false;
    const c = map.getCenter();
    this.tmap = new window.Tmapv3!.Map(box, {
      center: new window.Tmapv3!.LatLng(c.lat, c.lng),
      width: "100%",
      height: "100%",
      zoom: Math.round(map.getZoom()),
    });
    // Fingers belong to MapLibre, on top; this one only follows.
    this.tmap.setInteractive(false);
    this.camera = this.tmap.vsmMap().getCamera();
    this.camera.setMaxPitch?.(85);
    map.on("move", this.sync);
    map.on("resize", this.fit);
    this.copy();
  }

  private copy() {
    const c = this.map.getCenter();
    this.camera.jumpTo({ center: [c.lng, c.lat], zoom: this.map.getZoom(), bearing: this.map.getBearing(), pitch: this.map.getPitch() });
  }

  destroy() {
    this.map.off("move", this.sync);
    this.map.off("resize", this.fit);
    this.tmap.destroy();
    this.box.replaceChildren();
    this.box.hidden = true;
  }
}
