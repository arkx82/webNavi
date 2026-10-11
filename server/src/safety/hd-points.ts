import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
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
 *
 * A bump is on one lane of one road, and the page needs to know which: on
 * 2026-10-11 ten of fourteen bump warnings were for bumps on a road beside
 * the route (a frontage road over an underpass, a side lane, the other
 * carriageway, 5–24 m off), passed at 70–92 km/h. So each bump carries
 * its lane (BumpFeature.lane) from the lane links in lanes.db
 * (server/src/lanes.ts builds it): an HD bump its own link (2019's
 * LinkID), or else the lane under it; a public bump the lane within
 * PUBLIC_SNAP_M of it, where the HD map surveyed its road — put on that
 * lane, its own place being rough. web/src/warnings.ts takes a bump with
 * a lane as on the route only where the route runs on that lane.
 */
const NEAR_M = 20;
const M = 111_320;
/** An HD bump's own link this near its middle is its lane (95 % are within 3.3 m; a few links are another place's, 200 m off). */
export const OWN_LINK_M = 4;
/** An HD bump without its link (2024's have none, and some links are not in the map): the lane this near its middle. */
export const HD_SNAP_M = 3;
/** A public bump this near a lane of the HD map is on that road; further off, on a street the map has not surveyed. */
export const PUBLIC_SNAP_M = 5;
/** Public bumps looked up between turns of the event loop: 134 000 at once held the server for 7 s. */
const LOOKUP_BATCH = 500;

/**
 * The lane a speed bump lies on: the way it runs (deg, −1 where no lane is known) and the bump's place on it — an HD
 * bump's own middle, a public bump's nearest point on the lane.
 */
export interface BumpLane { deg: number; at: [number, number] }
export type BumpFeature = Feature & { lane?: BumpLane };

export class HdPoints {
  features: BumpFeature[] = [];
  private loaded = new Map<string, number>();
  /** The lane links (lanes.db), opened at each refresh that finds them; null before they are built. */
  private lanes: Lanes | null = null;
  /** The public bumps' lanes, by id and place: the lists come through without() at every rebuild of the index. */
  private publicLanes = new Map<string, BumpLane | null>();

  constructor(private dir: string, private log: (msg: string) => void = () => {}, private lanesFile = join(dir, "lanes.db")) {}

  /** Reads the files again if any changed since (the lanes too: the bumps' lanes come from them); true when the features are new. */
  async refresh(): Promise<boolean> {
    let changed = false;
    const files = { lights: join(this.dir, "lights.geojsons"), bumps: join(this.dir, "bumps.geojsons"), lanes: this.lanesFile };
    for (const [name, file] of Object.entries(files)) {
      const m = existsSync(file) ? statSync(file).mtimeMs : 0;
      if (m !== (this.loaded.get(name) ?? -1)) changed = true;
    }
    if (!changed) return false;
    this.loaded.set("lanes", existsSync(this.lanesFile) ? statSync(this.lanesFile).mtimeMs : 0);
    this.lanes?.close();
    this.lanes = Lanes.open(this.lanesFile, this.log);
    this.publicLanes.clear();
    const out: BumpFeature[] = [];
    for (const name of ["lights", "bumps"] as const) {
      const file = files[name];
      if (!existsSync(file)) { this.loaded.set(name, 0); continue; }
      this.loaded.set(name, statSync(file).mtimeMs);
      let n = 0, laned = 0;
      for await (const line of createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })) {
        const t = line.trim();
        if (!t) continue;
        try {
          const raw = JSON.parse(t) as RawFeature;
          const f: BumpFeature | null = featureOf(name, raw);
          if (!f) continue;
          if (f.kind === "bump") {
            f.lane = this.lanes ? hdBumpLane(this.lanes, f, raw.properties?.link) : { deg: -1, at: [f.lon, f.lat] };
            if (f.lane.deg >= 0) laned++;
          }
          out.push(f);
          n++;
        } catch { /* a half line */ }
      }
      this.log(`hdmap ${name}: ${n} features${name === "bumps" ? `, ${laned} on a known lane` : ""}`);
    }
    this.features = out;
    return true;
  }

  /**
   * [features] less those of a kind the HD map has within NEAR_M: the HD point stands for both. A public speed bump
   * kept is put on the HD lane within PUBLIC_SNAP_M of it, where there is one (BumpFeature.lane).
   */
  without(features: Feature[]): BumpFeature[] {
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
    const kept = features.filter((f) => {
      const [kind, ry, rx] = key(f).split(":");
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        for (const h of cells.get(`${kind}:${Number(ry) + dy}:${Number(rx) + dx}`) ?? []) {
          if (metres(f, h) <= NEAR_M) return false;
        }
      }
      return true;
    });
    if (!this.lanes) return kept;
    let fresh = false;
    const out = kept.map((f) => {
      if (f.kind !== "bump") return f;
      const k = `${f.id}:${f.lon},${f.lat}`;
      const lane = this.publicLanes.get(k);
      if (lane !== undefined) return lane ? { ...f, lane } : f;
      // Not looked for yet: a copy of its own, its lane set on it in the background (the index keeps this copy, and
      // hands out what it has when asked) — the first look at the national list is seconds of SQLite.
      const c: BumpFeature = { ...f };
      this.pending.push([c, k]);
      fresh = true;
      return c;
    });
    if (fresh) this.lookUpLanes();
    return out;
  }

  /** The public bumps whose lanes are still to be looked for, with their keys in publicLanes. */
  private pending: [BumpFeature, string][] = [];
  private looking: Promise<void> | null = null;

  /** Resolves when every public bump handed out has been looked for (for tests, and the log). */
  lanesSettled(): Promise<void> {
    return this.looking ?? Promise.resolve();
  }

  /** Looks the pending public bumps' lanes up, LOOKUP_BATCH at a time between other work. */
  private lookUpLanes() {
    if (this.looking) return;
    this.looking = (async () => {
      let n = 0, laned = 0;
      while (this.pending.length) {
        const lanes = this.lanes;
        const batch = this.pending.splice(0, LOOKUP_BATCH);
        if (!lanes) continue;
        for (const [c, k] of batch) {
          let lane = this.publicLanes.get(k);
          if (lane === undefined) {
            const hit = lanes.nearest(c.lon, c.lat, PUBLIC_SNAP_M);
            lane = hit ? { deg: Math.round(hit.deg), at: hit.at } : null;
            this.publicLanes.set(k, lane);
          }
          if (lane) { c.lane = lane; laned++; }
          n++;
        }
        await new Promise((done) => setImmediate(done));
      }
      if (n) this.log(`hdmap lanes: ${laned} of ${n} public bumps on a lane of the HD map`);
    })().finally(() => { this.looking = null; });
  }
}

/** An HD bump's lane: its own link where that runs by it, else the lane under it; deg −1 where neither. */
export function hdBumpLane(lanes: Pick<Lanes, "link" | "nearest">, f: Feature, link: string | undefined): BumpLane {
  const own = link ? lanes.link(link, f.lon, f.lat) : null;
  const hit = own && own.d <= OWN_LINK_M ? own : lanes.nearest(f.lon, f.lat, HD_SNAP_M);
  return { deg: hit ? Math.round(hit.deg) : -1, at: [f.lon, f.lat] };
}

/** Where a point is on a lane: metres off it, the lane's way there, and the nearest point of it. */
interface OnLane { d: number; deg: number; at: [number, number] }

/** The lane links of lanes.db (server/src/lanes.ts), read only: a link by its ID, the nearest to a point. */
export class Lanes {
  private constructor(private db: DatabaseSync, private byId: StatementSync, private box: StatementSync) {}

  static open(file: string, log: (msg: string) => void = () => {}): Lanes | null {
    if (!existsSync(file)) return null;
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      return new Lanes(db, db.prepare("SELECT coords FROM links WHERE id = ?"),
        db.prepare("SELECT l.coords FROM box b JOIN links l ON l.rowid = b.rowid WHERE b.minx <= ? AND b.maxx >= ? AND b.miny <= ? AND b.maxy >= ?"));
    } catch (e) {
      log(`hdmap lanes not read: ${(e as Error).message}`);
      return null;
    }
  }

  close() {
    try { this.db.close(); } catch { /* closed */ }
  }

  /** Link [id] where it is nearest the point; null where the map has no such link. */
  link(id: string, lon: number, lat: number): OnLane | null {
    const row = this.byId.get(id) as { coords: string } | undefined;
    return row ? onLane(JSON.parse(row.coords) as number[][], lon, lat) : null;
  }

  /** The lane nearest the point within [withinM]; null where none is. */
  nearest(lon: number, lat: number, withinM: number): OnLane | null {
    const dy = withinM / M, dx = withinM / (M * Math.cos((lat * Math.PI) / 180));
    let best: OnLane | null = null;
    for (const row of this.box.all(lon + dx, lon - dx, lat + dy, lat - dy) as { coords: string }[]) {
      const o = onLane(JSON.parse(row.coords) as number[][], lon, lat);
      if (o.d <= withinM && (!best || o.d < best.d)) best = o;
    }
    return best;
  }
}

/** The point of the polyline [line] nearest (lon, lat), how far it is, and the line's way there. */
export function onLane(line: number[][], lon: number, lat: number): OnLane {
  const kx = M * Math.cos((lat * Math.PI) / 180);
  let best: OnLane = { d: Infinity, deg: -1, at: [lon, lat] };
  for (let i = 0; i + 1 < line.length; i++) {
    const ax = (line[i][0] - lon) * kx, ay = (line[i][1] - lat) * M;
    const bx = (line[i + 1][0] - lon) * kx, by = (line[i + 1][1] - lat) * M;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.d) {
      best = {
        d,
        deg: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360,
        at: [Number((line[i][0] + t * (line[i + 1][0] - line[i][0])).toFixed(7)), Number((line[i][1] + t * (line[i + 1][1] - line[i][1])).toFixed(7))],
      };
    }
  }
  return best;
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
