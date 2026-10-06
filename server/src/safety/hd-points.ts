import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { Feature } from "./index.js";

/**
 * 정밀도로지도's traffic lights and speed bumps (tools/hdmap/build.py:
 * lights.geojsons, bumps.geojsons under WORK_DIR/hdmap) as safety
 * features, beside the public lists: the national traffic-light list
 * covers little (in Seoul, 동작구 alone), while the HD map has every light
 * on every road it surveyed. Where both know a thing, the HD map's point
 * stands and the public one within NEAR_M of it is left out, so nothing
 * is drawn or said twice.
 *
 * Lights: only a car's (2019 Type 1–9; 2024 LightType 1xx) — a walker's
 * light (11, 2xx) is not what "다음 신호등" means. Bumps come as polygons;
 * their middle is the point.
 */
const NEAR_M = 20;
const M = 111_320;

export class HdPoints {
  features: Feature[] = [];
  private loaded = new Map<string, number>();

  constructor(private dir: string, private log: (msg: string) => void = () => {}) {}

  /** Reads the files again if either changed since; true when the features are new. */
  async refresh(): Promise<boolean> {
    let changed = false;
    for (const name of ["lights", "bumps"] as const) {
      const file = join(this.dir, `${name}.geojsons`);
      const m = existsSync(file) ? statSync(file).mtimeMs : 0;
      if (m !== (this.loaded.get(name) ?? -1)) changed = true;
    }
    if (!changed) return false;
    const out: Feature[] = [];
    for (const name of ["lights", "bumps"] as const) {
      const file = join(this.dir, `${name}.geojsons`);
      if (!existsSync(file)) { this.loaded.set(name, 0); continue; }
      this.loaded.set(name, statSync(file).mtimeMs);
      let n = 0;
      for await (const line of createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })) {
        const t = line.trim();
        if (!t) continue;
        try {
          const f = featureOf(name, JSON.parse(t) as RawFeature);
          if (f) { out.push(f); n++; }
        } catch { /* a half line */ }
      }
      this.log(`hdmap ${name}: ${n} features`);
    }
    this.features = out;
    return true;
  }

  /** [features] less those of a kind the HD map has within NEAR_M: the HD point stands for both. */
  without(features: Feature[]): Feature[] {
    if (this.features.length === 0) return features;
    const cells = new Map<string, Feature[]>();
    // One cos for every point (Korea's middle): with each point's own, two 20 m apart north–south fell in cells
    // more than one apart east–west (lon·M is 1.4e7; a cos differing in the sixth place moves the cell), and
    // 9 % of such pairs were kept twice.
    const kx = M * Math.cos((36 * Math.PI) / 180);
    const key = (f: Feature) => `${f.kind}:${Math.floor(f.lat * M / NEAR_M)}:${Math.floor(f.lon * kx / NEAR_M)}`;
    for (const f of this.features) {
      const k = key(f);
      (cells.get(k) ?? cells.set(k, []).get(k)!).push(f);
    }
    return features.filter((f) => {
      const [kind, ry, rx] = key(f).split(":");
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        for (const h of cells.get(`${kind}:${Number(ry) + dy}:${Number(rx) + dx}`) ?? []) {
          if (metres(f, h) <= NEAR_M) return false;
        }
      }
      return true;
    });
  }
}

interface RawFeature { properties?: { id?: string; t?: string | number; link?: string }; geometry?: { type: string; coordinates: unknown } }

/** A car's traffic light: 2019's Type 1–9, 2024's LightType 1xx. */
export function isCarLight(t: string | number | undefined | null): boolean {
  const s = String(t ?? "").trim();
  if (!s) return true;
  if (s.length <= 2) { const n = Number(s); return n >= 1 && n <= 9; }
  return s.startsWith("1");
}

export function featureOf(name: "lights" | "bumps", f: RawFeature): Feature | null {
  const g = f.geometry;
  if (!g || !f.properties?.id) return null;
  if (name === "lights") {
    if (!isCarLight(f.properties.t)) return null;
    const c = g.type === "Point" ? (g.coordinates as number[]) : g.type === "MultiPoint" ? (g.coordinates as number[][])[0] : null;
    if (!c || c.length < 2) return null;
    return { id: `hd:light:${f.properties.id}`, kind: "signal-light", lon: c[0], lat: c[1] };
  }
  const c = centroid(g);
  if (!c) return null;
  return { id: `hd:bump:${f.properties.id}`, kind: "bump", lon: c[0], lat: c[1] };
}

/** The middle of a polygon's (or multipolygon's) outer ring vertices. */
function centroid(g: { type: string; coordinates: unknown }): [number, number] | null {
  let ring: number[][] | null = null;
  if (g.type === "Polygon") ring = (g.coordinates as number[][][])[0];
  else if (g.type === "MultiPolygon") ring = (g.coordinates as number[][][][])[0]?.[0];
  else if (g.type === "Point") return (g.coordinates as number[]).slice(0, 2) as [number, number];
  if (!ring || ring.length === 0) return null;
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

function metres(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const k = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot((a.lon - b.lon) * M * k, (a.lat - b.lat) * M);
}
