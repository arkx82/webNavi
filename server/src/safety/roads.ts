import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Feature } from "./index.js";

/**
 * Each enforcement camera put on its own carriageway: for each of eight
 * headings, the nearest road of our own graph (표준노드링크, one-way links,
 * the osrm service's /nearest with a bearing) — the heading whose road the
 * camera stands on is the way its traffic goes. Kept by camera id in
 * camera-roads.json beside the cameras. The page then takes a camera as the
 * route's only where one of its ways runs with the route and on it
 * (web/src/warnings.ts): on 2026-10-04 a camera on 강변북로 westbound, 19 m
 * from the route east onto 청담대교, was warned of on the ramp ("제한 속도 팔십").
 */
const KINDS = new Set(["speed", "signal", "speed-signal", "section-start", "section-end", "school-zone", "senior-zone"]);
/** A 보호구역 is put on the one road nearest its school (deg -1: any way): the street its gate is on. */
const ZONES = new Set(["school-zone", "senior-zone"]);
/** A camera further than this from any road of the graph is left as it is. */
const SNAP_MAX_M = 25;
/** A school further than this from any road says nothing of which. */
const ZONE_SNAP_MAX_M = 150;
/** Ways within this of the nearest are the camera's too: a two-way street, a camera at a crossing. */
const SAME_M = 4;
const HEADINGS = [0, 45, 90, 135, 180, 225, 270, 315];
const AT_ONCE = 8;

export interface CameraWay {
  /** The heading the road runs, ±23°; -1 for a 보호구역's street (any way). */
  deg: number;
  /** The camera put on that road. */
  at: [number, number];
  /** A 보호구역's street: its lanes one way, by 정밀도로지도 (null where the map has none there). */
  lanes?: number | null;
  /** A 보호구역's street: its name ("양재대로"; "" unnamed). */
  name?: string;
}

type Kept = Record<string, CameraWay[] | null>;

export class CameraRoads {
  private kept: Kept = {};
  private running = false;

  constructor(private dir: string, private base: () => string | undefined, private log: (m: string) => void = () => {}, private lanesAt: (at: [number, number]) => number | null | undefined = () => undefined) {
    const file = join(dir, "camera-roads.json");
    if (existsSync(file)) try { this.kept = JSON.parse(readFileSync(file, "utf8")) as Kept; } catch { /* asked again */ }
  }

  /** [features] with their ways, where known. */
  apply(features: Feature[]): Feature[] {
    return features.map((f) => {
      const ways = this.kept[f.id];
      return ways ? { ...f, ways } : f;
    });
  }

  /** The camera's ways, asked of the graph; null where no road is near; throws where the graph cannot be asked. */
  private async waysOf(base: string, f: Feature): Promise<CameraWay[] | null> {
    if (ZONES.has(f.kind)) {
      const res = await fetch(`${base}/nearest/v1/driving/${f.lon},${f.lat}?number=1`, { signal: AbortSignal.timeout(5000) });
      const w = ((await res.json()) as { waypoints?: { location: [number, number]; distance: number; name?: string }[] }).waypoints?.[0];
      if (!w || w.distance > ZONE_SNAP_MAX_M) return null;
      const at: [number, number] = [Number(w.location[0].toFixed(6)), Number(w.location[1].toFixed(6))];
      // Lanes counted where the lane map is up; not yet (the server starting), asked again on the next round.
      const lanes = this.lanesAt(at);
      const name = w.name ?? "";
      return [lanes === undefined ? { deg: -1, at, name } : { deg: -1, at, lanes, name }];
    }
    const found: { deg: number; at: [number, number]; d: number }[] = [];
    for (const deg of HEADINGS) {
      const res = await fetch(`${base}/nearest/v1/driving/${f.lon},${f.lat}?number=1&bearings=${deg},23`, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { code?: string; waypoints?: { location: [number, number]; distance: number }[] };
      // No road that way is an answer; anything else (TooBig, InvalidQuery, a half-up server) is not, and is asked again next round.
      if (body.code !== "Ok" && body.code !== "NoSegment") throw new Error(`nearest ${body.code ?? res.status}`);
      const w = body.waypoints?.[0];
      if (w) found.push({ deg, at: [Number(w.location[0].toFixed(6)), Number(w.location[1].toFixed(6))], d: w.distance });
    }
    const nearest = Math.min(...found.map((w) => w.d));
    if (!Number.isFinite(nearest) || nearest > SNAP_MAX_M) return null;
    return found.filter((w) => w.d <= nearest + SAME_M).map(({ deg, at }) => ({ deg, at }));
  }

  /** Asks the graph for the cameras not yet put on a road; true when any was. */
  async fill(features: Feature[]): Promise<boolean> {
    const base = this.base();
    if (!base || this.running) return false;
    // A zone put on its street before its lanes were counted (lanes undefined) is asked again.
    const todo = features.filter((f) => KINDS.has(f.kind) && (!(f.id in this.kept) || (ZONES.has(f.kind) && this.kept[f.id]?.[0] && (this.kept[f.id]![0].lanes === undefined || this.kept[f.id]![0].name === undefined))));
    if (!todo.length) return false;
    this.running = true;
    let done = 0, failed = 0;
    try {
      let next = 0;
      const work = async () => {
        while (next < todo.length) {
          const f = todo[next++];
          try {
            this.kept[f.id] = await this.waysOf(base, f);
            // Kept as it goes: the whole list is twenty minutes, and a restart should not start it over.
            if (++done % 2000 === 0) writeFileSync(join(this.dir, "camera-roads.json"), JSON.stringify(this.kept));
          } catch {
            failed++;
            // The graph not up (a restart): left for the next round.
            if (failed > 50 && done === 0) return;
          }
        }
      };
      await Promise.all(Array.from({ length: AT_ONCE }, work));
      writeFileSync(join(this.dir, "camera-roads.json"), JSON.stringify(this.kept));
      this.log(`camera roads: ${done} cameras put on their carriageway${failed ? `, ${failed} not asked` : ""}`);
      return done > 0;
    } finally {
      this.running = false;
    }
  }
}
