import type maplibregl from "maplibre-gl";
import type { Route } from "./types";

/**
 * The route on the map: one line feature per congestion segment so the
 * colour changes along the road, and a dot per turn guide. Sources are
 * added once and refilled, which is cheaper than layers coming and going.
 */
const COLOURS: Record<number, string> = {
  0: "#5b8def", // unknown: plain route blue
  1: "#3ddc84", // free
  2: "#ffb300", // slow
  3: "#ff4d4f", // congested
};

export class RouteLayer {
  private ready = false;

  constructor(private map: maplibregl.Map) {}

  private install() {
    if (this.ready) return;
    const empty = { type: "FeatureCollection", features: [] } as GeoJSON.FeatureCollection;
    this.map.addSource("route", { type: "geojson", data: empty });
    this.map.addSource("guides", { type: "geojson", data: empty });
    this.map.addLayer({
      id: "route-casing", type: "line", source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#0b1a33", "line-width": 12, "line-opacity": 0.9 },
    });
    this.map.addLayer({
      id: "route-line", type: "line", source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-width": 7,
        "line-color": ["match", ["get", "congestion"], 1, COLOURS[1], 2, COLOURS[2], 3, COLOURS[3], COLOURS[0]],
      },
    });
    this.map.addLayer({
      id: "guides", type: "circle", source: "guides",
      paint: { "circle-radius": 5, "circle-color": "#fff", "circle-stroke-color": "#0b1a33", "circle-stroke-width": 2 },
    });
    this.ready = true;
  }

  show(route: Route | null) {
    this.install();
    const lines: GeoJSON.Feature[] = [];
    const dots: GeoJSON.Feature[] = [];
    if (route) {
      for (const s of route.segments) {
        const coords = route.path.slice(s.from, Math.min(route.path.length, s.to + 1));
        if (coords.length < 2) continue;
        lines.push({ type: "Feature", properties: { congestion: s.congestion }, geometry: { type: "LineString", coordinates: coords } });
      }
      // A provider with no segments still has a path.
      if (lines.length === 0 && route.path.length > 1) {
        lines.push({ type: "Feature", properties: { congestion: 0 }, geometry: { type: "LineString", coordinates: route.path } });
      }
      for (const g of route.guides) {
        dots.push({ type: "Feature", properties: { text: g.text }, geometry: { type: "Point", coordinates: g.at } });
      }
    }
    (this.map.getSource("route") as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features: lines });
    (this.map.getSource("guides") as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features: dots });
  }

  /** The whole route in view, with room for the panel on the left. */
  fit(route: Route) {
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of route.path) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    this.map.fitBounds([[minX, minY], [maxX, maxY]], { padding: { top: 60, bottom: 60, left: 360, right: 60 }, pitch: 0, bearing: 0, duration: 800 });
  }
}
