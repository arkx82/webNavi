import type { Feature } from "./index.js";

/**
 * One camera, one row. The national list gives many cameras twice: once by 경찰청 (1320000-…) and once by the
 * local agency that runs it (5600000-…), and some once per lane ("1,2차로", "3,4차로"). The two rows can disagree on
 * the limit — 운천제2교차로 G1211 is 70 "(포천->김화)" from one and 80 from the other, 3 m apart — and the page
 * took whichever came first in the answer, which is the nearer to where it asked: 80 one way, 70 the other
 * (2026-10-11). Rows of one kind this near that are the same camera are kept as one: the row whose site names a
 * direction, at the lower limit of the two.
 *
 * Not every pair this near is one camera. Most are two cameras on one pole, each facing a carriageway —
 * "압록보건진료소 앞(곡성→구례)" and "(구례→곡성)" at the same point — and some are one agency's rows all put at one
 * placeholder point (합천's 교동교차로 and 초계초등학교, both at one spot). So two rows are one camera only where
 * they say nothing against it (no two directions, no two direction codes of one agency) and something for it:
 * the same camera number from two agencies, or the same place named.
 */
export const SAME_CAMERA_M = 15;
const KINDS = new Set(["speed", "signal", "speed-signal", "section-start", "section-end"]);

/** The way a camera's site names — "포천->김화", "(신철원>영중면)", "광양방면", "상행" — evened out; null where it names none. */
export function siteDirection(site: string | undefined): string | null {
  const s = site ?? "";
  const arrow = s.match(/([^\s(),:>→=-]+)\s*(?:->|→|=>|>)\s*([^\s(),:>→=-]+)/);
  if (arrow) return `${arrow[1]}→${arrow[2]}`;
  const toward = s.match(/([^\s(),:]+(?:방향|방면)|상행|하행)/);
  return toward ? toward[1] : null;
}

/** The place a site names, without its direction, lanes or spaces: "운천제2교차로" of "운천제2교차로 (포천->김화)". */
export function sitePlace(site: string | undefined): string {
  return (site ?? "")
    .replace(/\([^()]*\)?/g, "")
    .replace(/\d+(?:\s*,\s*\d+)*\s*차로/g, "")
    .replace(/[\s.,:·\-_()[\]]/g, "");
}

/**
 * How far before the place its coordinates are a site puts the camera: 400 of "양문사거리전400m지점", 80 of
 * "숯골사거리 80m전". The list gives such a camera the junction's own coordinates (F6204 and the junction's signal
 * camera F6124 at the very same point), so it is not one camera with whatever else stands there.
 */
export function beforeOf(site: string | undefined): number | undefined {
  const s = site ?? "";
  const m = s.match(/전\s*(\d+)\s*(?:m|M|미터)/) ?? s.match(/(\d+)\s*(?:m|M|미터)\s*전/);
  const n = m ? Number(m[1]) : NaN;
  return n > 0 ? n : undefined;
}

/** The agency and its number for the camera: ["1320000", "G1211"] of "police-api:1320000-G1211". */
function agencyOf(f: Feature): [string, string] {
  const id = f.id.slice(f.id.indexOf(":") + 1);
  const dash = id.indexOf("-");
  return dash < 0 ? [f.id.slice(0, f.id.indexOf(":")), id] : [id.slice(0, dash), id.slice(dash + 1)];
}
const code = (f: Feature) => (f.direction ?? "").trim().replace(/^0+/, "");

const metres = (a: Feature, b: Feature) => Math.hypot((b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180), (b.lat - a.lat) * 111_320);
/** A camera facing back ("복합물류삼거리(후면)"): the other way's, whatever its site does not say. */
const rear = (f: Feature) => /후면/.test(f.site ?? "");

/**
 * Whether two rows say nothing against being one camera: no two directions named, no rear camera with a front
 * one, no two direction codes of one agency.
 */
function compatible(a: Feature, b: Feature): boolean {
  if (a.kind !== b.kind) return false;
  const da = siteDirection(a.site), db = siteDirection(b.site);
  if (da && db && da !== db) return false;
  if (rear(a) !== rear(b)) return false;
  if (agencyOf(a)[0] === agencyOf(b)[0] && code(a) && code(b) && code(a) !== code(b)) return false;
  return true;
}

/**
 * Whether two compatible rows are one camera: the same camera number from two agencies (경찰청's numbers, a letter
 * and digits — a local agency's "7" is any agency's seventh), or the same place named and then: from one agency,
 * the same direction named (one camera per lane: "1,2차로", "3,4차로") or the very same point (a row given twice —
 * two rows of one place a few metres apart, no direction said, are as often two approaches of one junction); from
 * two, a direction named by either, or else the same direction code.
 */
function sameCamera(a: Feature, b: Feature): boolean {
  if (!compatible(a, b)) return false;
  const [ag, na] = agencyOf(a), [bg, nb] = agencyOf(b);
  if (ag !== bg && na === nb && /[A-Za-z]/.test(na)) return true;
  const pa = sitePlace(a.site), pb = sitePlace(b.site);
  if (!pa || !pb || !(pa.includes(pb) || pb.includes(pa))) return false;
  const da = siteDirection(a.site), db = siteDirection(b.site);
  if (ag === bg) return (!!da && da === db) || metres(a, b) <= 1;
  return !!(da || db) || code(a) === code(b);
}

export interface Merged {
  kept: string;
  ids: string[];
  limits: (number | undefined)[];
  limit?: number;
}

/**
 * [features] with each camera given twice kept once (see above): the row whose site names a direction (else the
 * first by id), at the lowest limit any of its rows gives, with the zone of any of them and the ways of all.
 * Returns what was merged, and where the limits differed.
 */
export function dedupeCameras(features: Feature[]): { features: Feature[]; merged: Merged[] } {
  const cell = (f: Feature) => [Math.floor(f.lon * 5000), Math.floor(f.lat * 5000)];
  const cams = features.filter((f) => KINDS.has(f.kind)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const groups: Feature[][] = [];
  const byCell = new Map<string, Feature[][]>();
  for (const f of cams) {
    const [x, y] = cell(f);
    let home: Feature[] | null = null;
    for (let dx = -1; dx <= 1 && !home; dx++) for (let dy = -1; dy <= 1 && !home; dy++) {
      for (const g of byCell.get(`${x + dx},${y + dy}`) ?? []) {
        if (g.every((m) => compatible(m, f) && metres(m, f) <= SAME_CAMERA_M) && g.some((m) => sameCamera(m, f))) { home = g; break; }
      }
    }
    if (home) { home.push(f); continue; }
    const g = [f];
    groups.push(g);
    byCell.set(`${x},${y}`, [...(byCell.get(`${x},${y}`) ?? []), g]);
  }
  const replace = new Map<Feature, Feature | null>();
  const merged: Merged[] = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    const kept = g.find((f) => siteDirection(f.site)) ?? g[0];
    const limits = g.map((f) => f.limit);
    const known = limits.filter((l): l is number => l != null);
    const limit = known.length ? Math.min(...known) : undefined;
    const zone = kept.zone ?? g.find((f) => f.zone)?.zone;
    // Every carriageway any of its rows was put on: a way lost is a camera lost to the page's other-way rule.
    const ways = g.flatMap((f) => f.ways ?? []).filter((w, i, all) => all.findIndex((o) => o.deg === w.deg && Math.abs(o.at[0] - w.at[0]) + Math.abs(o.at[1] - w.at[1]) < 0.00005) === i);
    replace.set(kept, { ...kept, ...(limit != null ? { limit } : {}), ...(zone ? { zone } : {}), ...(ways.length ? { ways } : {}) });
    for (const f of g) if (f !== kept) replace.set(f, null);
    merged.push({ kept: kept.id, ids: g.map((f) => f.id), limits, limit });
  }
  if (!replace.size) return { features, merged };
  const out: Feature[] = [];
  for (const f of features) {
    const r = replace.get(f);
    if (r === undefined) out.push(f);
    else if (r) out.push(r);
  }
  return { features: out, merged };
}
