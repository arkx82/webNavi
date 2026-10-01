import type maplibregl from "maplibre-gl";

/**
 * 정밀도로지도 on the ground, close in: each lane line as painted — white
 * or yellow (blue for a bus lane), single or double, solid or dashed, from
 * its three-digit type — and the arrows and crosswalks on the road. Tiles
 * from the server (/api/hdmap/tiles, tools/hdmap/build.py), drawn under the
 * route so the way to go is always on top, and only from zoom 16, where a
 * lane is wide enough to be told apart (and a small car computer is spared
 * the rest).
 */
export const HD_MIN_ZOOM = 16;
const LAYERS = ["hd-marks", "hd-lines", "hd-lines-dashed"];

type Bounds = [number, number, number, number];

/** The tiles' coverage as the server says it, only where it is a box within Korea; else no bounds. */
export function coverage(bounds: unknown): Bounds | null {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [w, s, e, n] = bounds as Bounds;
  if (!(w < e && s < n && w >= 124 && e <= 132 && s >= 33 && n <= 39)) return null;
  return [w, s, e, n];
}

/** The lines' colours by the type's first digit: 1 yellow, 2 white (grey by day, on a light ground), 3 blue. */
const colour = (day: boolean): maplibregl.ExpressionSpecification =>
  ["match", ["slice", ["to-string", ["get", "t"]], 0, 1], "1", "#f2c200", "3", "#3d7bff", day ? "#9aa1ab" : "#f4f4f4"];

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
    for (const id of ["hd-lines", "hd-lines-dashed"]) this.map.setPaintProperty(id, "line-color", colour(day));
    this.map.setPaintProperty("hd-marks", "fill-color", day ? "#aeb4bd" : "#eeeeee");
  }

  /** Put away for the moment (driving on at speed with no turn near): the lanes are the heaviest thing drawn in a city. */
  private away = false;

  /** The driver's switch (안내 설정 → 정밀 차선), and whether they are put away for now. */
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
    const double = ["==", ["slice", ["to-string", ["get", "t"]], 1, 2], "2"] as maplibregl.ExpressionSpecification;
    const width = ["interpolate", ["linear"], ["zoom"], 16, 0.8, 18, 2, 20, 4] as maplibregl.ExpressionSpecification;
    // The zoom only at the top of an expression: the case (double or single) goes inside each stop.
    const gap = ["interpolate", ["linear"], ["zoom"], 16, ["case", double, 0.8, 0], 18, ["case", double, 2, 0], 20, ["case", double, 4, 0]] as maplibregl.ExpressionSpecification;
    const add = (layer: maplibregl.LayerSpecification) => { if (!this.map.getLayer(layer.id)) this.map.addLayer(layer, before); };
    add({
      id: "hd-marks", type: "fill", source: "hdmap", "source-layer": "marks", minzoom: HD_MIN_ZOOM,
      paint: { "fill-color": this.day ? "#aeb4bd" : "#eeeeee", "fill-opacity": 0.85 },
    });
    add({
      id: "hd-lines", type: "line", source: "hdmap", "source-layer": "lines", minzoom: HD_MIN_ZOOM,
      filter: ["!=", third, "2"],
      paint: { "line-color": colour(this.day), "line-width": width, "line-gap-width": gap },
    });
    add({
      id: "hd-lines-dashed", type: "line", source: "hdmap", "source-layer": "lines", minzoom: HD_MIN_ZOOM,
      filter: ["==", third, "2"],
      paint: { "line-color": colour(this.day), "line-width": width, "line-gap-width": gap, "line-dasharray": [3, 3] },
    });
    this.ready = true;
    this.refresh();
  }
}
