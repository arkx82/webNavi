import type maplibregl from "maplibre-gl";
import type { Line } from "./geo";

/**
 * 보호구역 on the road itself: the stretch of the route a school (or a home
 * for the old) makes a zone, as a band along the route line's own shape —
 * red for a child's, orange for an old person's, amber for a 구간 단속
 * between its cameras — a little wider than the route line at every zoom
 * (route-layer.ts), so it reads as the road lit, not a smear over the town.
 */
export interface Zone { id: string; kind: "school-zone" | "senior-zone" | "section"; alongM: number; endM: number }
/** 구간 단속 too: the stretch between its cameras, in yellow (warnings.ts sections()). */
const WORDS = { "school-zone": "어린이 보호구역", "senior-zone": "노인 · 장애인 보호구역", section: "구간 단속" };

export class ZoneLayer {
  private ready = false;
  private data: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  private key = "";
  /** The line the bands were last drawn along. */
  private line: Line | null = null;

  constructor(private map: maplibregl.Map) {
    map.on("style.load", () => { this.ready = false; this.tryInstall(); });
    map.on("idle", () => { if (!this.ready) this.tryInstall(); });
    this.tryInstall();
  }

  /** The zones on the route, drawn directly along the route line's exact coordinates. */
  set(zones: Zone[], line: Line | null) {
    const key = line ? zones.map((z) => `${z.id}:${Math.round(z.alongM)}:${Math.round(z.endM)}`).join("|") : "";
    if (key === this.key && line === this.line) return;
    this.key = key;
    this.line = line;
    const features: GeoJSON.Feature[] = [];
    for (const z of line ? zones : []) {
      const coords = line!.slice(z.alongM, z.endM);
      if (coords.length < 2) continue;
      features.push({
        type: "Feature",
        properties: { kind: z.kind },
        geometry: { type: "LineString", coordinates: coords },
      });
      features.push({
        type: "Feature",
        properties: { kind: z.kind, words: WORDS[z.kind] },
        geometry: { type: "Point", coordinates: line!.place((z.alongM + z.endM) / 2).at },
      });
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
    // Rich, distinct colors: child zone red, senior orange, section enforcement vibrant amber/yellow.
    const colour = ["match", ["get", "kind"], "senior-zone", "#ff8a3d", "section", "#f59e0b", "#e5484d"] as maplibregl.ExpressionSpecification;
    const opacity = ["match", ["get", "kind"], "section", 0.50, 0.35] as maplibregl.ExpressionSpecification;

    // Widths in screen pixels, scaled with the zoom as the route line's are (route-layer.ts: its casing is 8 px at
    // zoom 11 and 14 at 18): a band wider than the line, never one that covers the town when zoomed out.
    const bandWidth = ["interpolate", ["linear"], ["zoom"], 11, 10, 15, 16, 18, 22] as maplibregl.ExpressionSpecification;
    const glowWidth = ["interpolate", ["linear"], ["zoom"], 11, 16, 15, 24, 18, 32] as maplibregl.ExpressionSpecification;

    // A soft glow under the band.
    if (!this.map.getLayer("zones-edge")) this.map.addLayer({
      id: "zones-edge", type: "line", source: "zones", filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": colour, "line-width": glowWidth, "line-opacity": 0.22 },
    }, before);

    // The band itself, along the route's exact line.
    if (!this.map.getLayer("zones-fill")) this.map.addLayer({
      id: "zones-fill", type: "line", source: "zones", filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": colour, "line-width": bandWidth, "line-opacity": opacity },
    }, before);

    if (!this.map.getLayer("zones-words")) this.map.addLayer({
      id: "zones-words", type: "symbol", source: "zones", filter: ["==", ["geometry-type"], "Point"], minzoom: 13,
      layout: { "text-field": ["get", "words"], "text-font": ["Noto Sans Bold"], "text-size": 14, "text-allow-overlap": true, "text-pitch-alignment": "map", "text-rotation-alignment": "viewport" },
      paint: { "text-color": colour, "text-halo-color": "#ffffff", "text-halo-width": 2.5 },
    });
    this.ready = true;
    (this.map.getSource("zones") as maplibregl.GeoJSONSource | undefined)?.setData(this.data);
  }
}
