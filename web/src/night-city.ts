import type maplibregl from "maplibre-gl";

/**
 * 야경: by night, in the tilted view, the buildings round the car stand
 * lit — a warm gold that brightens with height, over the dimmed ground —
 * the way a city looks from the road after dark. OpenStreetMap's building
 * footprints and heights (OpenFreeMap's tiles: the same the OSM ground
 * draws its grey buildings from), so the effect is only as full as OSM is:
 * dense in Seoul and the big cities, thin elsewhere. Only over a ground
 * that is dark by night (TMAP's, NAVER's, under the shade): the OSM
 * ground stays light after dark, and lit buildings on a light map look
 * wrong — there the style's own grey ones stay.
 */
export const NIGHT_CITY_MIN_ZOOM = 14;
export const NIGHT_CITY_LAYER = "night-city";
const SOURCE = "night-city";
const TILES = "https://tiles.openfreemap.org/planet";

/** Gold by height: a low block glows dimly, a tower shines. Faint, so the road and the route stay in view under them. */
const HEIGHT: maplibregl.ExpressionSpecification = ["to-number", ["get", "render_height"], 8];
const COLOUR: maplibregl.ExpressionSpecification = [
  "interpolate", ["linear"], HEIGHT,
  0, "#6b5a3a", 20, "#a8863f", 60, "#d1a752", 150, "#e9c477",
];
export const NIGHT_CITY_OPACITY = 0.35;

export class NightCity {
  private ready = false;
  private night = false;

  /** [enabled]: the driver's switch and the view (only tilted); [changed]: told when the layer is drawn or not. */
  constructor(private map: maplibregl.Map, private enabled: () => boolean, private changed: () => void = () => {}) {
    // A new style (the plain ground) takes the layer with it; made after the style came, the next
    // quiet moment is the first chance to put it back.
    map.on("style.load", () => { this.ready = false; this.tryInstall(); });
    map.on("idle", () => { if (!this.ready) this.tryInstall(); });
    this.tryInstall();
  }

  /** Whether the lit buildings are being drawn now. */
  get showing(): boolean {
    return this.ready && this.night && this.enabled();
  }

  setNight(night: boolean) {
    if (this.night === night) return;
    this.night = night;
    this.refresh();
  }

  /** After the driver's switch or the view changed. */
  refresh() {
    if (!this.ready) return;
    try {
      this.map.setLayoutProperty(NIGHT_CITY_LAYER, "visibility", this.showing ? "visible" : "none");
    } catch { /* the layer went with a style change; the next idle puts it back */ }
    this.changed();
  }

  private tryInstall() {
    try { this.install(); } catch { /* the style not done yet: the next idle tries again */ }
  }

  private install() {
    if (this.ready) return;
    // The OSM ground has the same tiles already; the overlay (TMAP, NAVER ground) gets its own source.
    const source = this.map.getSource("openmaptiles") ? "openmaptiles" : SOURCE;
    if (source === SOURCE && !this.map.getSource(SOURCE)) {
      this.map.addSource(SOURCE, { type: "vector", url: TILES, attribution: "© OpenStreetMap contributors" });
    }
    // Under the route (route-layer.ts) when it is there already; else it comes on top by itself.
    const before = this.map.getLayer("alts-line") ? "alts-line" : undefined;
    if (!this.map.getLayer(NIGHT_CITY_LAYER)) {
      this.map.addLayer({
        id: NIGHT_CITY_LAYER, type: "fill-extrusion", source, "source-layer": "building", minzoom: NIGHT_CITY_MIN_ZOOM,
        layout: { visibility: "none" },
        paint: {
          "fill-extrusion-color": COLOUR,
          "fill-extrusion-height": HEIGHT,
          "fill-extrusion-base": ["to-number", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": NIGHT_CITY_OPACITY,
          "fill-extrusion-vertical-gradient": true,
        },
      }, before);
    }
    this.ready = true;
    this.refresh();
  }
}
