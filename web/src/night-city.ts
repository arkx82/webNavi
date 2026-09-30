import type maplibregl from "maplibre-gl";

/**
 * 야경: by night, in the tilted view, the buildings round the car stand
 * lit — a warm gold that brightens with height, over the dimmed ground —
 * the way a city looks from the road after dark. OpenStreetMap's building
 * footprints and heights (OpenFreeMap's tiles: the same the OSM ground
 * draws its grey buildings from), so the effect is only as full as OSM is:
 * dense in Seoul and the big cities, thin elsewhere. On the OSM ground
 * the style's own grey buildings step aside while these are shown.
 */
export const NIGHT_CITY_MIN_ZOOM = 14;
export const NIGHT_CITY_LAYER = "night-city";
const SOURCE = "night-city";
const TILES = "https://tiles.openfreemap.org/planet";

/** Gold by height: a low block glows dimly, a tower shines. */
const COLOUR: maplibregl.ExpressionSpecification = [
  "interpolate", ["linear"], ["coalesce", ["get", "render_height"], 0],
  0, "#5a4622", 20, "#a37b2c", 60, "#d9a441", 150, "#f2c96b",
];

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
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": 0.75,
          "fill-extrusion-vertical-gradient": true,
        },
      }, before);
    }
    this.ready = true;
    this.refresh();
  }
}
