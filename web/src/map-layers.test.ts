import { test } from "node:test";
import assert from "node:assert/strict";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type maplibregl from "maplibre-gl";
import { CameraLayer } from "./camera-layer";
import { HdLayer } from "./hdmap-layer";
import { NightCity } from "./night-city";
import { PinLayer } from "./pin-layer";
import { RouteLayer } from "./route-layer";
import { ZoneLayer } from "./zone-layer";

/**
 * Every layer the page adds, checked against MapLibre's style rules. A
 * layer the map refuses is not an error on screen — it is just not there
 * (the cameras' sizes once multiplied a zoom curve, and no camera drew).
 */
function fakeMap() {
  const sources: Record<string, unknown> = {};
  const layers: maplibregl.LayerSpecification[] = [];
  const map = {
    on: () => map, off: () => map, once: () => map,
    isStyleLoaded: () => false,
    // A source as the layers use it: its data set later.
    getSource: (id: string) => (sources[id] ? { setData: () => {}, setTiles: () => {} } : undefined),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    addSource: (id: string, s: unknown) => { sources[id] = s; },
    addLayer: (l: maplibregl.LayerSpecification) => { layers.push(l); },
    hasImage: () => true, addImage: () => {}, removeImage: () => {},
    getZoom: () => 16, getStyle: () => ({ layers: [] }), getCanvas: () => ({ style: {} }),
    setLayoutProperty: () => {}, setPaintProperty: () => {}, setFilter: () => {},
  };
  return { map: map as unknown as maplibregl.Map, sources, layers };
}

test("every map layer is one MapLibre accepts", async () => {
  const { map, sources, layers } = fakeMap();
  // The camera layer's own timer, which a test does not want running.
  (globalThis as { window?: unknown }).window ??= { setInterval: () => 0, clearInterval: () => {} };
  const made: unknown[] = [
    new CameraLayer(map, () => true, () => {}),
    new HdLayer(map, () => true),
    new NightCity(map, () => true),
    new PinLayer(map, () => {}),
    new RouteLayer(map),
    new ZoneLayer(map),
  ];
  for (const m of made) {
    const o = m as { image?: unknown; install: () => unknown };
    // Icons are drawn on a canvas, which this is not: taken as made.
    if ("image" in o) o.image = async () => {};
    await o.install();
  }
  const ids = layers.map((l) => l.id);
  for (const id of ["cams", "cams-next", "lights", "zones-fill", "route-line"]) assert.ok(ids.includes(id), `${id} added`);
  const errors = validateStyleMin({
    version: 8,
    glyphs: "https://example.org/{fontstack}/{range}.pbf",
    sources: sources as maplibregl.StyleSpecification["sources"],
    layers,
  });
  assert.deepEqual(errors.map((e) => e.message), []);
});

test("the route line's edge width is read off the same stops the layer draws with", async () => {
  const { casingPx, CASING_STOPS } = await import("./route-layer");
  for (const [z, px] of CASING_STOPS) assert.equal(casingPx(z), px);
  assert.equal(casingPx(16.5), 13);
  assert.equal(casingPx(9), 8);
  assert.equal(casingPx(20), 14);
});
