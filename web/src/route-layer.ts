import type maplibregl from "maplibre-gl";
import type { LonLat, Route } from "./types";

/**
 * The route on the map: one line feature per congestion segment so the
 * colour changes along the road, and a dot per turn guide. Sources are
 * added once and refilled, which is cheaper than layers coming and going.
 */
export const COLOURS: Record<number, string> = {
  0: "#5b8def", // unknown: plain route blue
  1: "#3ddc84", // free
  2: "#ffb300", // slow
  3: "#ff4d4f", // congested
};

/** The route line's dark edge, its width in screen pixels by zoom: [zoom, px] stops, linear between. */
export const CASING_STOPS: [number, number][] = [[11, 8], [15, 12], [18, 14]];
/** The casing's width at [zoom], as the map draws it (the same stops as its layer). */
export function casingPx(zoom: number): number {
  return between(CASING_STOPS, zoom);
}
/** The route line's own width, [zoom, px] stops. */
export const LINE_STOPS: [number, number][] = [[11, 4], [15, 7], [18, 9]];
/** A value from [zoom, value] stops, linear between, held beyond the ends. */
function between(s: [number, number][], zoom: number): number {
  if (zoom <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (zoom <= s[i][0]) return s[i - 1][1] + ((zoom - s[i - 1][0]) / (s[i][0] - s[i - 1][0])) * (s[i][1] - s[i - 1][1]);
  }
  return s[s.length - 1][1];
}

/**
 * 차선 띠 (TMAP's lane-level concept, 2026-11-26): near a turn whose lanes are known, the route drawn as wide as a
 * lane, on the lane the line was put on (thread.ts) — the lane to be in, not a line down the road. As wide as
 * BAND_LANE_M on the ground at each zoom, and never narrower than the route line under it (drawn back, a lane is a
 * few pixels).
 */
export const BAND_LANE_M = 3.3;
export const BAND_COLOUR = "#2f7bff";
export function bandStops(lat: number, laneM = BAND_LANE_M): [number, number][] {
  const out: [number, number][] = [];
  for (let z = 12; z <= 22; z++) {
    const metresPerPx = (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** z);
    out.push([z, Math.round(Math.max(laneM / metresPerPx, between(LINE_STOPS, z) + 1) * 10) / 10]);
  }
  return out;
}

/** The band's width by zoom at [lat], and its light's (BAND_GLOW_PX wider), as MapLibre expressions. */
const BAND_GLOW_PX = 8;
function bandWidths(lat: number): [maplibregl.ExpressionSpecification, maplibregl.ExpressionSpecification] {
  const stops = bandStops(lat);
  const of = (add: number) => ["interpolate", ["exponential", 2], ["zoom"], ...stops.flatMap(([z, px]) => [z, px + add])] as maplibregl.ExpressionSpecification;
  return [of(0), of(BAND_GLOW_PX)];
}

export class RouteLayer {
  private ready = false;
  private last: [Route | null, Route[]] = [null, []];
  private lastBand: { lines: LonLat[][]; lat: number } = { lines: [], lat: 37.5 };

  constructor(private map: maplibregl.Map) {
    // A new style (switching the ground, or the plain fallback) takes the sources with it: what was shown
    // is drawn again on the new one. Registering once("style.load") from inside a style.load handler
    // would be lost (maplibre fires a copy of the listener list), so the next quiet moment tries instead —
    // isStyleLoaded() stays false while the new style's tiles load.
    map.on("style.load", () => { this.ready = false; this.tryInstall(); });
    map.on("idle", () => { if (!this.ready) this.tryInstall(); });
  }

  /** Puts the sources and layers on the style, then what was last shown on them; a style not done yet throws, and the next idle tries again. */
  private tryInstall() {
    try { this.install(); } catch { return; }
    if (this.last[0] || this.last[1].length) this.fill(...this.last);
    if (this.lastBand.lines.length) this.band(this.lastBand.lines, this.lastBand.lat);
  }

  private install() {
    if (this.ready) return;
    const empty = { type: "FeatureCollection", features: [] } as GeoJSON.FeatureCollection;
    for (const id of ["alts", "route", "band", "guides"]) if (!this.map.getSource(id)) this.map.addSource(id, { type: "geojson", data: empty });
    const add = (layer: maplibregl.LayerSpecification) => { if (!this.map.getLayer(layer.id)) this.map.addLayer(layer); };
    // The other offers, grey and under the chosen one, the way a route
    // preview shows what was not picked.
    add({
      id: "alts-line", type: "line", source: "alts",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#8a8f99", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 3, 15, 6, 18, 8], "line-opacity": 0.7, "line-blur": 0.3 },
    });
    add({
      id: "route-casing", type: "line", source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#0b1a33", "line-width": ["interpolate", ["linear"], ["zoom"], ...CASING_STOPS.flat()], "line-opacity": 0.9, "line-blur": 0.4 },
    });
    add({
      id: "route-line", type: "line", source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        // Narrower drawn back, wider close in; the edge feathered slightly (a shader constant, no cost) on top of the canvas's own antialiasing.
        "line-width": ["interpolate", ["linear"], ["zoom"], ...LINE_STOPS.flat()],
        "line-blur": 0.3,
        "line-color": ["match", ["get", "congestion"], 1, COLOURS[1], 2, COLOURS[2], 3, COLOURS[3], COLOURS[0]],
      },
    });
    // 차선 띠: a soft light round it, then the lane itself, over the route line.
    const [lane, glow] = bandWidths(37.5);
    add({
      id: "band-glow", type: "line", source: "band",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#7fb2ff", "line-width": glow, "line-opacity": 0.45, "line-blur": 6 },
    });
    add({
      id: "band-lane", type: "line", source: "band",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": BAND_COLOUR, "line-width": lane, "line-opacity": 0.92, "line-blur": 0.5 },
    });
    add({
      id: "guides", type: "circle", source: "guides",
      paint: { "circle-radius": 5, "circle-color": "#fff", "circle-stroke-color": "#0b1a33", "circle-stroke-width": 2 },
    });
    this.ready = true;
  }

  show(route: Route | null, alternates: Route[] = []) {
    this.last = [route, alternates];
    // A route can arrive before the style has: sources cannot be added until it is, so the drawing waits
    // for the next idle, which finds it in [last].
    if (!this.ready) { this.tryInstall(); return; }
    this.fill(route, alternates);
  }

  private fill(route: Route | null, alternates: Route[]) {
    (this.map.getSource("alts") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: alternates.filter((a) => a !== route && a.path.length > 1).map((a) => ({
        type: "Feature", properties: { provider: a.provider }, geometry: { type: "LineString", coordinates: a.path },
      })),
    });
    const lines: GeoJSON.Feature[] = [];
    const dots: GeoJSON.Feature[] = [];
    if (route) {
      // Every stretch of the path, the ones no segment names as unknown: a line with holes is not a route.
      const segments = [...route.segments].sort((a, b) => a.from - b.from);
      let at = 0;
      const whole: { from: number; to: number; congestion: number }[] = [];
      for (const s of segments) {
        if (s.from > at) whole.push({ from: at, to: s.from, congestion: 0 });
        whole.push(s);
        at = Math.max(at, s.to);
      }
      if (at < route.path.length - 1) whole.push({ from: at, to: route.path.length, congestion: 0 });
      for (const s of whole) {
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

  /** The 차선 띠 stretches ([lines], each a piece of the route's path), as wide as a lane at [lat]; none for none. */
  band(lines: LonLat[][], lat: number) {
    this.lastBand = { lines, lat };
    if (!this.ready) return;
    (this.map.getSource("band") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: lines.filter((l) => l.length > 1).map((l) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: l } })),
    });
    const [lane, glow] = bandWidths(lat);
    this.map.setPaintProperty("band-lane", "line-width", lane);
    this.map.setPaintProperty("band-glow", "line-width", glow);
  }

  /** Every route in view, with room for the panel on the left. */
  fit(...routes: Route[]) {
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of routes.flatMap((r) => r.path)) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    // The camera's own margins (kept from following the car) would add to these.
    this.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    this.map.fitBounds([[minX, minY], [maxX, maxY]], { padding: { top: 60, bottom: 60, left: 360, right: 60 }, pitch: 0, bearing: 0, duration: 800 });
  }
}
