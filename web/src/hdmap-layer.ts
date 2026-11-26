import type maplibregl from "maplibre-gl";

/**
 * 정밀도로지도's lane lines on the ground, plain: thin white lines (grey by
 * day), solid or dashed, nothing else — no arrows, no crosswalks, no double
 * lines, no colours. With the 차선 띠 over them (route-layer.ts) they show
 * which of the lanes the route is in, as TMAP's lane-level concept draws it
 * (2026-11-26). Drawn as each painted line was (2026-10-11 … 11-01) they
 * cluttered the map and were dropped with the closer zoom; now only near a
 * band or slow (main.ts lanesAway), and from zoom 16, where lanes are a few
 * pixels apart. Tiles from the server (/api/hdmap/tiles,
 * tools/hdmap/build.py), drawn under the route.
 */
export const HD_MIN_ZOOM = 16;
const LAYERS = ["hd-lines", "hd-lines-dashed"];

type Bounds = [number, number, number, number];

/** The tiles' coverage as the server says it, only where it is a box within Korea; else no bounds. */
export function coverage(bounds: unknown): Bounds | null {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [w, s, e, n] = bounds as Bounds;
  if (!(w < e && s < n && w >= 124 && e <= 132 && s >= 33 && n <= 39)) return null;
  return [w, s, e, n];
}

/** One colour for every line: white by night, grey on a light day map. */
const colour = (day: boolean) => (day ? "#a3aab4" : "#e8ecf2");

export class HdLayer {
  private ready = false;
  private day = false;
  /** Where there are tiles at all, asked of the server once; undefined until it answers, null for no bounds. */
  private bounds: Bounds | null | undefined = undefined;

  constructor(private map: maplibregl.Map, private enabled: () => boolean) {
    // A new style (the plain ground) takes the layers with it; and made after the style came, the
    // first chance is the next quiet moment — isStyleLoaded() is false while tiles still load.
    map.on("style.load", () => { this.ready = false; this.tryInstall(); });
    map.on("idle", () => { if (!this.ready) this.tryInstall(); });
    // The source waits for the coverage: with it, no tile outside is ever asked for.
    void fetch("/api/hdmap/info").then((a) => (a.ok ? a.json() : null)).then((info: { bounds?: unknown } | null) => { this.bounds = coverage(info?.bounds); })
      .catch(() => { this.bounds = null; })
      .then(() => this.tryInstall());
  }

  private tryInstall() {
    try { this.install(); } catch { /* the style not done yet: the next idle tries again */ }
  }

  /** The screen's theme: white lines are lost on a light ground by day. */
  setDay(day: boolean) {
    this.day = day;
    if (!this.ready) return;
    for (const id of LAYERS) this.map.setPaintProperty(id, "line-color", colour(day));
  }

  /** Put away for the moment (no band near, not slow): the lanes are the heaviest thing drawn in a city. */
  private away = true;

  /** The driver's switch (안내 설정 → 차선 단위 안내), and whether they are put away for now. */
  refresh() {
    if (!this.ready) return;
    const on = this.enabled() && !this.away;
    for (const id of LAYERS) this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  }

  /** [away]: not drawn for now, whatever the switch; changes only when it differs (a style change each frame would cost more than the lanes). */
  setAway(away: boolean) {
    if (away === this.away) return;
    this.away = away;
    this.refresh();
  }

  private install() {
    if (this.ready || this.bounds === undefined) return;
    if (!this.map.getSource("hdmap")) this.map.addSource("hdmap", {
      type: "vector",
      tiles: [`${location.origin}/api/hdmap/tiles/{z}/{x}/{y}.pbf`],
      minzoom: 15,
      maxzoom: 18,
      attribution: "© 국토지리정보원 정밀도로지도",
      ...(this.bounds ? { bounds: this.bounds } : {}),
    });
    // Under the route (route-layer.ts) when it is there already; else it comes on top by itself.
    const before = this.map.getLayer("alts-line") ? "alts-line" : undefined;
    const third = ["slice", ["to-string", ["get", "t"]], 2, 3] as maplibregl.ExpressionSpecification;
    const width = ["interpolate", ["linear"], ["zoom"], 16, 0.6, 18, 1.2, 20, 2.4] as maplibregl.ExpressionSpecification;
    const add = (layer: maplibregl.LayerSpecification) => { if (!this.map.getLayer(layer.id)) this.map.addLayer(layer, before); };
    add({
      id: "hd-lines", type: "line", source: "hdmap", "source-layer": "lines", minzoom: HD_MIN_ZOOM,
      filter: ["!=", third, "2"],
      layout: { visibility: "none" },
      paint: { "line-color": colour(this.day), "line-width": width, "line-opacity": 0.8 },
    });
    add({
      id: "hd-lines-dashed", type: "line", source: "hdmap", "source-layer": "lines", minzoom: HD_MIN_ZOOM,
      filter: ["==", third, "2"],
      layout: { visibility: "none" },
      paint: { "line-color": colour(this.day), "line-width": width, "line-opacity": 0.8, "line-dasharray": [4, 4] },
    });
    this.ready = true;
    this.refresh();
  }
}
