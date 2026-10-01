import type maplibregl from "maplibre-gl";
import type { Line } from "./geo";
import type { LonLat } from "./types";

/**
 * 보호구역 on the road itself: the stretch of the route a school (or a home
 * for the old) makes a zone, as a translucent band the road's width — red
 * for a child's, orange for an old person's, yellow for a 구간 단속 between
 * its cameras — with its name, so the car is seen to be in it, not only told.
 */
export interface Zone { id: string; kind: "school-zone" | "senior-zone" | "section"; alongM: number; endM: number }
const HALF_WIDTH_M = 11;
/** 구간 단속 too: the stretch between its cameras, in yellow (warnings.ts sections()). */
const WORDS = { "school-zone": "어린이 보호구역", "senior-zone": "노인 · 장애인 보호구역", section: "구간 단속" };

export class ZoneLayer {
  private ready = false;
  private data: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  private key = "";
  /** The line the bands were last drawn along: a new line (the route moved onto the lanes) draws them again. */
  private line: Line | null = null;

  constructor(private map: maplibregl.Map) {
    map.on("style.load", () => { this.ready = false; this.tryInstall(); });
    map.on("idle", () => { if (!this.ready) this.tryInstall(); });
    this.tryInstall();
  }

  /** The zones on the route, drawn along [line] (the route's own shape, so a bend is a bent band). */
  set(zones: Zone[], line: Line | null) {
    const key = line ? zones.map((z) => `${z.id}:${Math.round(z.alongM)}`).join("|") : "";
    if (key === this.key && line === this.line) return;
    this.key = key;
    this.line = line;
    const features: GeoJSON.Feature[] = [];
    for (const z of line ? zones : []) {
      const left: LonLat[] = [], right: LonLat[] = [];
      for (let m = z.alongM; m <= z.endM + 0.1; m += Math.max(5, (z.endM - z.alongM) / 40)) {
        const p = line!.place(m);
        const rad = ((p.bearing + 90) * Math.PI) / 180;
        const k = 111_320 * Math.cos((p.at[1] * Math.PI) / 180);
        const dx = (Math.sin(rad) * HALF_WIDTH_M) / k, dy = (Math.cos(rad) * HALF_WIDTH_M) / 111_320;
        right.push([p.at[0] + dx, p.at[1] + dy]);
        left.push([p.at[0] - dx, p.at[1] - dy]);
      }
      if (left.length < 2) continue;
      features.push({ type: "Feature", properties: { kind: z.kind }, geometry: { type: "Polygon", coordinates: [[...left, ...right.reverse(), left[0]]] } });
      features.push({ type: "Feature", properties: { kind: z.kind, words: WORDS[z.kind] }, geometry: { type: "Point", coordinates: line!.place((z.alongM + z.endM) / 2).at } });
    }
    this.data = { type: "FeatureCollection", features };
    (this.map.getSource("zones") as maplibregl.GeoJSONSource | undefined)?.setData(this.data);
  }

  private tryInstall() {
    try { this.install(); } catch { /* the style not done yet: the next idle tries again */ }
  }

  private install() {
    if (this.ready) return;
    if (!this.map.getSource("zones")) this.map.addSource("zones", { type: "geojson", data: this.data });
    // Under the route line, over the ground and the lanes.
    const before = this.map.getLayer("alts-line") ? "alts-line" : undefined;
    const colour = ["match", ["get", "kind"], "senior-zone", "#ff8a3d", "section", "#f5c518", "#e5484d"] as maplibregl.ExpressionSpecification;
    if (!this.map.getLayer("zones-fill")) this.map.addLayer({ id: "zones-fill", type: "fill", source: "zones", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": colour, "fill-opacity": 0.24 } }, before);
    if (!this.map.getLayer("zones-edge")) this.map.addLayer({ id: "zones-edge", type: "line", source: "zones", filter: ["==", ["geometry-type"], "Polygon"], paint: { "line-color": colour, "line-width": 2, "line-opacity": 0.7 } }, before);
    if (!this.map.getLayer("zones-words")) this.map.addLayer({
      id: "zones-words", type: "symbol", source: "zones", filter: ["==", ["geometry-type"], "Point"], minzoom: 14,
      layout: { "text-field": ["get", "words"], "text-font": ["Noto Sans Bold"], "text-size": 13, "text-allow-overlap": true, "text-pitch-alignment": "map", "text-rotation-alignment": "viewport" },
      paint: { "text-color": colour, "text-halo-color": "#ffffff", "text-halo-width": 2 },
    });
    this.ready = true;
    (this.map.getSource("zones") as maplibregl.GeoJSONSource | undefined)?.setData(this.data);
  }
}
