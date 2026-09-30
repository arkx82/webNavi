import type { FastifyInstance } from "fastify";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { AFTER_POINTS, LaneIndex, lanesAlong, type Turn } from "./lanes.js";
import type { LonLat } from "./route/types.js";

/**
 * 정밀도로지도's lane lines and road markings as vector tiles, from the
 * mbtiles tools/hdmap/build.py makes (under WORK_DIR). The file is opened
 * read-only and opened again when a rebuild replaces it (the file's time
 * looked at every few seconds, not every tile). Tiles come gzipped from
 * tippecanoe and are sent so.
 */
export const TILE_CACHE_CONTROL = "private, max-age=86400";

export class HdTiles {
  private db: DatabaseSync | null = null;
  /** The tile query, prepared once for each opening of the file. */
  private tileStmt: StatementSync | null = null;
  private opened = 0;
  private checked = 0;
  private meta: Record<string, string> = {};

  constructor(private file: string, private recheckMs = 5000) {}

  private open(): StatementSync | null {
    const now = Date.now();
    if (this.tileStmt && now - this.checked < this.recheckMs) return this.tileStmt;
    this.checked = now;
    if (!existsSync(this.file)) return null;
    const m = statSync(this.file).mtimeMs;
    if (this.tileStmt && m === this.opened) return this.tileStmt;
    this.db?.close();
    this.db = new DatabaseSync(this.file, { readOnly: true });
    this.opened = m;
    const rows = this.db.prepare("SELECT name, value FROM metadata").all() as { name: string; value: string }[];
    this.meta = Object.fromEntries(rows.map((r) => [r.name, r.value]));
    this.tileStmt = this.db.prepare("SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?");
    return this.tileStmt;
  }

  get ready() {
    return !!this.open();
  }

  info() {
    if (!this.open()) return null;
    const b = (this.meta.bounds ?? "").split(",").map(Number);
    return { bounds: b.length === 4 ? b : null, minzoom: Number(this.meta.minzoom ?? 15), maxzoom: Number(this.meta.maxzoom ?? 18), attribution: this.meta.attribution ?? "" };
  }

  tile(z: number, x: number, y: number): Buffer | null {
    const tiles = this.open();
    if (!tiles) return null;
    // mbtiles rows count from the south (TMS); the map's from the north.
    const row = (1 << z) - 1 - y;
    const r = tiles.get(z, x, row) as { tile_data: Uint8Array } | undefined;
    return r ? Buffer.from(r.tile_data) : null;
  }
}

export function registerHdmap(app: FastifyInstance, workDir: string) {
  const tiles = new HdTiles(join(workDir, "hdmap", "hdmap.mbtiles"));
  // The lane links' index, built beside them when a new links file comes (checked hourly).
  const lanes = new LaneIndex(join(workDir, "hdmap", "links.geojsons"), join(workDir, "hdmap", "lanes.db"), (m) => app.log.info(m));
  const refresh = () => void lanes.refresh().catch((e) => app.log.warn({ err: (e as Error).message }, "lanes index"));
  refresh();
  setInterval(refresh, 3_600_000).unref();
  // The lanes at the junction ahead: at=lon,lat of the guide, in=heading into it, way=the provider's turn,
  // after=the route's next 150 m or so as lon,lat;lon,lat…
  app.get<{ Querystring: { at: string; in: string; way?: string; after?: string } }>("/api/hdmap/lanes", async (request, reply) => {
    const at = request.query.at?.split(",").map(Number);
    const inDeg = Number(request.query.in);
    if (!at || at.length !== 2 || !at.every(Number.isFinite) || !Number.isFinite(inDeg)) return reply.code(400).send({ error: "at, in" });
    const after = (request.query.after ?? "").split(";").map((p) => p.split(",").map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite)) as LonLat[];
    const way = (["uturn", "left", "straight", "right", "fork"] as const).find((w) => w === request.query.way) ?? null;
    const info = lanes.lanes(at as LonLat, inDeg, after.slice(0, AFTER_POINTS), way as Turn | "fork" | null);
    request.log.debug({ lanes: info?.lanes.length ?? 0, at, inDeg, way, after: after.length }, "lanes asked");
    return info ?? { lanes: [] };
  });
  app.get("/api/hdmap/info", async () => tiles.info() ?? { bounds: null });
  app.get<{ Params: { z: string; x: string; y: string } }>("/api/hdmap/tiles/:z/:x/:y.pbf", async (request, reply) => {
    const z = Number(request.params.z), x = Number(request.params.x), y = Number(request.params.y);
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22) return reply.code(400).send({ error: "z/x/y" });
    const data = tiles.tile(z, x, y);
    // An empty tile is kept as long as a full one: outside the coverage every pan asked for them again.
    reply.header("Cache-Control", TILE_CACHE_CONTROL);
    if (!data) return reply.code(204).send();
    const gzipped = data[0] === 0x1f && data[1] === 0x8b;
    reply.header("Content-Type", "application/x-protobuf");
    if (gzipped) reply.header("Content-Encoding", "gzip");
    return reply.send(data);
  });
  // The junctions on the route ahead where some lanes do not go its way (a straight-and-left lane left-only
  // at the stop line): path=lon,lat;lon,lat… for the next kilometre or two.
  app.get<{ Querystring: { path?: string } }>("/api/hdmap/lanes-along", async (request) => {
    const path = (request.query.path ?? "").split(";").map((p) => p.split(",").map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite)) as LonLat[];
    if (path.length < 3 || !lanes.ready) return { junctions: [] };
    return { junctions: lanesAlong(lanes, path.slice(0, 200)) };
  });
  return tiles;
}
