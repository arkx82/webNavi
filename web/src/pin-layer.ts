import type maplibregl from "maplibre-gl";
import { CATEGORIES, LOOK } from "./categories";
import type { Category, LonLat } from "./types";

/**
 * The 주변 pins, drawn by the map itself: a round badge per place and a
 * pill beside it with its price or free count. They were DOM markers at
 * first, but a marker is moved on the map's "move" event and the canvas a
 * frame later, so with the camera following the car every frame the pins
 * swam over the road. As symbols they are drawn in the same frame as it.
 */
export interface Pin {
  id: string;
  at: LonLat;
  category: Category;
  label: string;
  tone: "plain" | "low" | "none" | "picked";
}

const PILLS = {
  plain: { fill: "#ffffff", ink: "#111111" },
  low: { fill: "#12b76a", ink: "#ffffff" },
  none: { fill: "#ffffff", ink: "#d33333" },
  picked: { fill: "#111111", ink: "#ffffff" },
};

export class PinLayer {
  private ready = false;
  private pins: Pin[] = [];

  constructor(private map: maplibregl.Map, private onPick: (id: string) => void) {
    // A new style (the plain ground, say) takes sources and images with it.
    map.on("style.load", () => {
      this.ready = false;
      void this.install();
    });
    for (const layer of ["pins-dot", "pins-label"]) {
      map.on("click", layer, (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (typeof id === "string") this.onPick(id);
      });
    }
    if (map.isStyleLoaded()) void this.install();
  }

  set(pins: Pin[]) {
    this.pins = pins;
    if (this.ready) this.fill();
  }

  private async install() {
    // Called from style.load, where isStyleLoaded() can still be false
    // while the sprite comes; sources and layers may be added all the same.
    if (this.ready) return;
    await Promise.all([
      ...CATEGORIES.flatMap((c) => [
        this.image(`pin-${c.id}`, badge(c.id, c.color), { pixelRatio: 2 }),
        this.image(`pin-${c.id}-none`, badge(c.id, "#8a8f99"), { pixelRatio: 2 }),
      ]),
      ...Object.entries(PILLS).map(([tone, p]) =>
        // Stretched round the text; the rounded ends are kept.
        this.image(`pill-${tone}`, pill(p.fill), { pixelRatio: 2, stretchX: [[20, 28]], stretchY: [[18, 22]], content: [12, 4, 36, 36] })),
    ]);
    if (this.ready || this.map.getSource("pins")) return;
    this.map.addSource("pins", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    const common: maplibregl.SymbolLayerSpecification["layout"] = {
      "symbol-sort-key": ["get", "z"],
      "icon-allow-overlap": true,
      "text-allow-overlap": true,
    };
    this.map.addLayer({
      id: "pins-label", type: "symbol", source: "pins", filter: ["!=", ["get", "label"], ""],
      layout: {
        ...common,
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 13,
        "text-max-width": 40,
        "text-anchor": "left",
        "text-offset": [1.3, 0],
        "icon-image": ["get", "pill"],
        "icon-text-fit": "both",
        "icon-text-fit-padding": [3, 8, 3, 12],
      },
      paint: { "text-color": ["get", "ink"] },
    });
    this.map.addLayer({
      id: "pins-dot", type: "symbol", source: "pins",
      layout: { ...common, "icon-image": ["get", "dot"], "icon-size": ["case", ["get", "picked"], 1.3, 1] },
    });
    this.ready = true;
    this.fill();
  }

  private fill() {
    (this.map.getSource("pins") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: this.pins.map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: p.at },
        properties: {
          id: p.id,
          label: p.label,
          dot: `pin-${p.category}${p.tone === "none" ? "-none" : ""}`,
          pill: `pill-${p.tone}`,
          ink: PILLS[p.tone].ink,
          picked: p.tone === "picked",
          // Drawn last, so on top: the open place, then the cheapest.
          z: p.tone === "picked" ? 2 : p.tone === "low" ? 1 : 0,
        },
      })),
    });
  }

  private async image(name: string, svg: string, options: Parameters<maplibregl.Map["addImage"]>[2]) {
    if (this.map.hasImage(name)) return;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    if (!this.map.hasImage(name)) this.map.addImage(name, img, options);
  }
}

/** A 64 px badge (32 css px at pixelRatio 2): the colour, a white ring, the icon. */
function badge(category: Category, fill: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<circle cx="32" cy="32" r="28" fill="${fill}" stroke="#fff" stroke-width="4"/>` +
    `<svg x="16" y="16" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" color="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${LOOK[category].path}</svg>` +
    `</svg>`;
}

function pill(fill: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="40" viewBox="0 0 48 40">` +
    `<rect x="1" y="1" width="46" height="38" rx="19" fill="${fill}" stroke="rgba(0,0,0,0.25)" stroke-width="2"/></svg>`;
}
