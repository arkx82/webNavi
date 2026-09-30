import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { LonLat } from "../route/types.js";

/**
 * ITS 소통정보 (its.go.kr trafficInfo: every monitored link's speed, on the
 * 표준노드링크 link ids, five-minute data) into the speeds our own router
 * drives by. Only while someone is using the router — a route asked, or a
 * car on the move asking for incidents — and only for the 1°×1° cells the
 * routes and the car are in: the key's daily allowance is small, and a
 * whole-country call times out anyway. Every five minutes the cells are
 * fetched and speeds.csv is written under WORK_DIR/nodelink (from_node,
 * to_node, km/h for every segment of every link heard of in the last 15
 * minutes); the osrm service (tools/nodelink/serve.sh) folds the file into
 * the graph and swaps it in. A link the file no longer names goes back to
 * its limit, so an idle stretch leaves no stale traffic behind.
 */
const URL = "https://openapi.its.go.kr:9443/trafficInfo";
/** ITS's own period: nothing new comes sooner. */
export const CYCLE_MS = 5 * 60_000;
/** Asked this recently, the router is in use and its cells are kept fresh. */
export const ACTIVE_MS = 10 * 60_000;
/** A speed older than this is dropped from the file: the link goes back to its limit. */
export const FRESH_MS = 15 * 60_000;
export const CELL_DEG = 1;
/** Korea, with room: nothing outside is ever asked for. */
const LON: [number, number] = [124, 132];
const LAT: [number, number] = [33, 39];

/** A cell by its south-west corner, "lon,lat" in whole degrees. */
export type Cell = string;

export function cellOf(p: LonLat): Cell | null {
  const lon = Math.floor(p[0] / CELL_DEG) * CELL_DEG, lat = Math.floor(p[1] / CELL_DEG) * CELL_DEG;
  if (lon < LON[0] || lon >= LON[1] || lat < LAT[0] || lat >= LAT[1]) return null;
  return `${lon},${lat}`;
}

/** The cells [points] pass through, the gaps between neighbours walked in quarter-cell steps. */
export function cellsAlong(points: LonLat[]): Set<Cell> {
  const cells = new Set<Cell>();
  const add = (p: LonLat) => { const c = cellOf(p); if (c) cells.add(c); };
  for (let i = 0; i < points.length; i++) {
    add(points[i]);
    if (i === 0) continue;
    const [ax, ay] = points[i - 1], [bx, by] = points[i];
    const steps = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) / (CELL_DEG / 4));
    for (let s = 1; s < steps; s++) add([ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps]);
  }
  return cells;
}

export function boxOf(cell: Cell): { minX: number; minY: number; maxX: number; maxY: number } {
  const [lon, lat] = cell.split(",").map(Number);
  return { minX: lon, minY: lat, maxX: lon + CELL_DEG, maxY: lat + CELL_DEG };
}

interface ItsItem { linkId?: string; speed?: string | number; travelTime?: string | number; createdDate?: string }
interface ItsAnswer { header?: { resultCode?: number | string; resultMsg?: string }; body?: { items?: ItsItem[] } }

/** links.db (tools/nodelink/build.py): a link's node sequence and limit, and a link by the nodes it joins. */
export class LinkBook {
  private db: DatabaseSync | null = null;
  private byId: StatementSync | null = null;
  private byEnds: StatementSync | null = null;

  constructor(private file: string) {}

  private open(): boolean {
    if (this.db) return true;
    if (!existsSync(this.file)) return false;
    this.db = new DatabaseSync(this.file, { readOnly: true });
    this.byId = this.db.prepare("SELECT nodes, maxspd FROM links WHERE id = ?");
    this.byEnds = this.db.prepare("SELECT id, maxspd FROM links WHERE f = ? AND t = ?");
    return true;
  }

  get ready() {
    return this.open();
  }

  /** The OSM node ids along a link, first to last. */
  nodesOf(linkId: string): number[] | null {
    if (!this.open()) return null;
    const r = this.byId!.get(linkId) as { nodes: string } | undefined;
    return r ? r.nodes.split(",").map(Number) : null;
  }

  /** The link from node [f] to node [t], and its limit in km/h. */
  between(f: number, t: number): { id: string; maxspd: number | null } | null {
    if (!this.open()) return null;
    const r = this.byEnds!.get(String(f), String(t)) as { id: string; maxspd: number | null } | undefined;
    return r ? { id: r.id, maxspd: r.maxspd } : null;
  }
}

export interface TrafficStatus {
  active: boolean;
  cells: number;
  links: number;
  lastAt: number | null;
  callsToday: number;
  lastError: string | null;
}

type Fetch = (url: string) => Promise<ItsAnswer>;

export class Traffic {
  readonly links: LinkBook;
  private speeds = new Map<string, { kmh: number; at: number }>();
  /** The cells wanted, each with when it was last asked for. */
  private wanted = new Map<Cell, number>();
  private touched = 0;
  private lastCycle = 0;
  private lastAt: number | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private calls = { day: "", n: 0 };

  constructor(
    private key: () => string | undefined,
    private dir: string,
    private log: (msg: string) => void = () => {},
    private fetchJson: Fetch = defaultFetch,
    private now: () => number = Date.now,
  ) {
    this.links = new LinkBook(join(dir, "links.db"));
  }

  get ready() {
    return !!this.key() && this.links.ready;
  }

  get active() {
    return this.now() - this.touched < ACTIVE_MS;
  }

  /** Someone is using the router round these points (a route's ends and path, or the car): keep their cells fresh. */
  touch(points: LonLat[]) {
    if (!this.ready) return;
    const t = this.now();
    for (const c of cellsAlong(points)) this.wanted.set(c, t);
    this.touched = t;
    this.kick();
  }

  /** The cells asked for recently enough to matter. */
  private liveCells(): Cell[] {
    const t = this.now();
    return [...this.wanted].filter(([, at]) => t - at < ACTIVE_MS).map(([c]) => c);
  }

  private kick() {
    if (this.timer || this.running) return;
    const due = Math.max(0, this.lastCycle + CYCLE_MS - this.now());
    this.timer = setTimeout(() => { this.timer = null; void this.cycle(); }, due);
    this.timer.unref?.();
  }

  /** One round: every live cell fetched, the file written; another round in five minutes while in use. */
  async cycle() {
    if (this.running) return;
    this.running = true;
    try {
      const cells = this.liveCells();
      if (!this.active || cells.length === 0) return;
      this.lastCycle = this.now();
      let heard = 0;
      for (const cell of cells) {
        try {
          heard += await this.fetchCell(cell);
        } catch (e) {
          this.lastError = (e as Error).message;
          this.log(`traffic ${cell}: ${this.lastError}`);
        }
      }
      const { links, segments } = this.writeSpeeds();
      this.log(`traffic: ${cells.length} cells, ${heard} links heard, ${links} links / ${segments} segments in speeds.csv`);
    } finally {
      this.running = false;
      if (this.active) this.kick();
    }
  }

  private async fetchCell(cell: Cell): Promise<number> {
    const box = boxOf(cell);
    const u = new globalThis.URL(URL);
    u.searchParams.set("apiKey", this.key()!);
    u.searchParams.set("type", "all");
    u.searchParams.set("getType", "json");
    u.searchParams.set("minX", String(box.minX));
    u.searchParams.set("minY", String(box.minY));
    u.searchParams.set("maxX", String(box.maxX));
    u.searchParams.set("maxY", String(box.maxY));
    this.count();
    const answer = await this.fetchJson(u.toString());
    const items = answer.body?.items;
    if (!Array.isArray(items)) throw new Error(`no items (${answer.header?.resultMsg ?? "?"})`);
    const at = this.now();
    let n = 0;
    for (const it of items) {
      const kmh = Number(it.speed);
      if (!it.linkId || !Number.isFinite(kmh) || kmh <= 0) continue;
      this.speeds.set(it.linkId, { kmh: Math.min(150, Math.max(3, Math.round(kmh))), at });
      n++;
    }
    this.lastAt = at;
    this.lastError = null;
    return n;
  }

  private count() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.calls.day !== day) this.calls = { day, n: 0 };
    this.calls.n++;
  }

  /** speeds.csv: every segment of every link heard of lately, written whole and moved into place. */
  writeSpeeds(): { links: number; segments: number } {
    const t = this.now();
    const lines: string[] = [];
    let links = 0;
    for (const [id, s] of this.speeds) {
      if (t - s.at > FRESH_MS) { this.speeds.delete(id); continue; }
      const nodes = this.links.nodesOf(id);
      if (!nodes) continue;
      links++;
      for (let i = 0; i + 1 < nodes.length; i++) lines.push(`${nodes[i]},${nodes[i + 1]},${s.kmh}`);
    }
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, "speeds.csv");
    writeFileSync(`${file}.new`, lines.join("\n") + (lines.length ? "\n" : ""));
    renameSync(`${file}.new`, file);
    return { links, segments: lines.length };
  }

  status(): TrafficStatus {
    return { active: this.active, cells: this.liveCells().length, links: this.speeds.size, lastAt: this.lastAt, callsToday: this.calls.n, lastError: this.lastError };
  }
}

async function defaultFetch(url: string): Promise<ItsAnswer> {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`ITS ${r.status}`);
  return (await r.json()) as ItsAnswer;
}
