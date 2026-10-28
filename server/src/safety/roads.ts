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
/** A camera further than this from any road of the graph is left as it is — unless a road of its name is near (FAR_SNAP_MAX_M). */
const SNAP_MAX_M = 25;
/**
 * A motorway camera this far from a road of its own name is put on that road: the list has some a long way off —
 * 구리포천고속도로 southbound's G5870 (소흘IC→민락IC) stands 143 m from the motorway, nearer nothing else, and was
 * never warned of (2026-10-11). Both carriageways of the road within FAR_SAME_M of the nearer are its ways (that
 * far off, the point says nothing of which) until pickCarriageways finds which. On a street the point is let stray
 * only FAR_STREET_M: 양문사거리's signal camera, 240 m off 호국로, is a junction's camera, and the nearest point of
 * 호국로 to it is not that junction.
 */
export const FAR_SNAP_MAX_M = 300;
export const FAR_STREET_M = 60;
const FAR_SAME_M = 40;
/** A road the list names as a motorway, or a city's car-only road. */
const MOTORWAY_NAME = /고속도로|도시고속|간선도로|자동차전용|순환로/;
/**
 * What the kept file holds: 2 asks again every camera put on no road (null), now that one far from its road can be
 * put on a road of its name. The version is kept in the file under "#v".
 */
export const ROADS_VERSION = 2;
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
  /** Put on a road of its name from further than SNAP_MAX_M (waysFrom): both carriageways, until one is picked. */
  far?: boolean;
}

type Kept = Record<string, CameraWay[] | null>;

/** A road's name evened out: "구리-포천고속도로" and "구리포천 고속도로" alike. */
const roadName = (s: string) => s.replace(/\([^()]*\)/g, "").replace(/[\s\-·.,_]/g, "");
/**
 * Whether a camera's 도로노선명 and the graph's name for a road are one road: the same name, one inside the other, or
 * two 고속도로 that share a place — the list still calls 세종포천고속도로's Guri–Pocheon stretch 구리-포천고속도로.
 */
export function sameRoad(camera: string | undefined, graph: string | undefined): boolean {
  const a = roadName(camera ?? ""), b = roadName(graph ?? "");
  if (a.length < 2 || b.length < 2) return false;
  if (a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a)))) return true;
  const motorway = /고속도로$/;
  if (!motorway.test(a) || !motorway.test(b)) return false;
  const pa = a.replace(motorway, ""), pb = b.replace(motorway, "");
  for (let i = 0; i + 2 <= pa.length; i++) if (pb.includes(pa.slice(i, i + 2))) return true;
  return false;
}

/**
 * A camera's ways from what the graph answered round it ([found], each heading's nearest roads, the nearest of
 * each marked first): the nearest road's headings where it is within SNAP_MAX_M, as before; else those of the
 * nearest road of the camera's own name ([name]) within FAR_SNAP_MAX_M, both its carriageways; else none.
 */
export function waysFrom(found: { deg: number; at: [number, number]; d: number; name?: string; first?: boolean }[], name: string | undefined): CameraWay[] | null {
  const firsts = found.filter((w) => w.first !== false);
  const nearest = Math.min(...firsts.map((w) => w.d));
  if (Number.isFinite(nearest) && nearest <= SNAP_MAX_M) return firsts.filter((w) => w.d <= nearest + SAME_M).map(({ deg, at }) => ({ deg, at }));
  const max = MOTORWAY_NAME.test(name ?? "") ? FAR_SNAP_MAX_M : FAR_STREET_M;
  const named = found.filter((w) => w.d <= max && sameRoad(name, w.name));
  if (!named.length) return null;
  // The nearest point of that road, and its carriageways there (not the same road again further round a bend).
  const base = named.reduce((a, b) => (b.d < a.d ? b : a));
  const by = (w: { at: [number, number] }) => Math.hypot((w.at[0] - base.at[0]) * 88_000, (w.at[1] - base.at[1]) * 111_320);
  const ways: CameraWay[] = [];
  for (const deg of HEADINGS) {
    const w = named.filter((o) => o.deg === deg && o.d <= base.d + FAR_SAME_M && by(o) <= FAR_SAME_M).sort((a, b) => a.d - b.d)[0];
    if (w) ways.push({ deg, at: w.at, far: true });
  }
  return ways;
}

const angle = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
/** Within this of a camera put on its road from far off, its agency's cameras of that road and direction code tell which carriageway. */
const PICK_WITHIN_M = 20_000;

/**
 * Of the carriageways a camera far off its road was put on (CameraWay.far), the one its agency's nearest camera of
 * the same road and direction code stands on (one carriageway, put on it from near): 1320000's code 2 on
 * 구리포천고속도로 is 포천→구리 at G5871 (225°), so G5870 is the southbound carriageway (180°), not the northbound
 * one (0°), which is nearer its point. Left with both where none says.
 */
export function pickCarriageways(features: Feature[]): Feature[] {
  const far = new Set(features.filter((f) => (f.ways?.length ?? 0) > 1 && f.ways!.some((w) => w.far)));
  if (!far.size) return features;
  const key = (f: Feature) => `${f.id.slice(0, Math.max(0, f.id.lastIndexOf("-")))}|${(f.direction ?? "").trim().replace(/^0+/, "")}`;
  const known = new Map<string, Feature[]>();
  for (const f of features) {
    const ways = f.ways ?? [];
    if (!ways.length || far.has(f) || ZONES.has(f.kind) || ways.some((w) => w.far || w.deg < 0)) continue;
    // One carriageway: its headings all within 90° of each other.
    if (ways.some((w) => angle(w.deg, ways[0].deg) >= 90)) continue;
    known.set(key(f), [...(known.get(key(f)) ?? []), f]);
  }
  return features.map((f) => {
    if (!far.has(f)) return f;
    let best: { d: number; deg: number } | null = null;
    for (const o of known.get(key(f)) ?? []) {
      if (!sameRoad(f.name, o.name)) continue;
      const d = Math.hypot((o.lon - f.lon) * 111_320 * Math.cos((f.lat * Math.PI) / 180), (o.lat - f.lat) * 111_320);
      if (d <= PICK_WITHIN_M && (!best || d < best.d)) best = { d, deg: o.ways![0].deg };
    }
    if (!best) return f;
    const keep = f.ways!.filter((w) => angle(w.deg, best!.deg) < 90);
    return keep.length && keep.length < f.ways!.length ? { ...f, ways: keep } : f;
  });
}

export class CameraRoads {
  private kept: Kept = {};
  private running = false;

  constructor(private dir: string, private base: () => string | undefined, private log: (m: string) => void = () => {}, private lanesAt: (at: [number, number]) => number | null | undefined = () => undefined) {
    const file = join(dir, "camera-roads.json");
    if (existsSync(file)) try {
      const read = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const v = read["#v"];
      delete read["#v"];
      this.kept = read as Kept;
      // An older file: the cameras it put on no road are asked again (a road of their name may be further off).
      if (v !== ROADS_VERSION) for (const id of Object.keys(this.kept)) if (this.kept[id] === null) delete this.kept[id];
    } catch { /* asked again */ }
  }

  private save() {
    writeFileSync(join(this.dir, "camera-roads.json"), JSON.stringify({ "#v": ROADS_VERSION, ...this.kept }));
  }

  /**
   * [features] with their ways, where known; a camera far off its road on the carriageway its neighbours say.
   *
   * The carriageway a camera's point is on is its way, whatever its site's "A→B" says. From 2026-10-15 to 10-28 a camera
   * whose neighbours' sites named the other way was told of both ways (125 in the country), after 영산로's G4699
   * "청수가든앞(목포→무안)", put on the 무안→목포 carriageway. 카카오 says it is the 무안→목포 camera: driven past both
   * ways in its SDK (2026-10-28), it was told going south only — and the tester was told of it going north, at a camera
   * across the road. One the list put on the wrong carriageway is told by 카카오 (안전운전 보완), which says what our
   * route's own cameras lack.
   */
  apply(features: Feature[]): Feature[] {
    return pickCarriageways(features.map((f) => {
      const ways = this.kept[f.id];
      return ways ? { ...f, ways } : f;
    }));
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
    // Each heading's three nearest roads: the nearest is the camera's where one is within SNAP_MAX_M; the others
    // are looked through for a road of its name further off.
    const found: { deg: number; at: [number, number]; d: number; name: string; first: boolean }[] = [];
    for (const deg of HEADINGS) {
      const res = await fetch(`${base}/nearest/v1/driving/${f.lon},${f.lat}?number=3&bearings=${deg},23`, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { code?: string; waypoints?: { location: [number, number]; distance: number; name?: string }[] };
      // No road that way is an answer; anything else (TooBig, InvalidQuery, a half-up server) is not, and is asked again next round.
      if (body.code !== "Ok" && body.code !== "NoSegment") throw new Error(`nearest ${body.code ?? res.status}`);
      (body.waypoints ?? []).forEach((w, i) => found.push({ deg, at: [Number(w.location[0].toFixed(6)), Number(w.location[1].toFixed(6))], d: w.distance, name: w.name ?? "", first: i === 0 }));
    }
    return waysFrom(found, f.name);
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
            if (++done % 2000 === 0) this.save();
          } catch {
            failed++;
            // The graph not up (a restart): left for the next round.
            if (failed > 50 && done === 0) return;
          }
        }
      };
      await Promise.all(Array.from({ length: AT_ONCE }, work));
      this.save();
      this.log(`camera roads: ${done} cameras put on their carriageway${failed ? `, ${failed} not asked` : ""}`);
      return done > 0;
    } finally {
      this.running = false;
    }
  }
}
