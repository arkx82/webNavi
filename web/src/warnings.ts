import { CAMERA_KINDS, WARNING_RUNGS_M, cameraRungs, warningPhrase } from "../../server/src/phrases";
import { Line, angleBetween, bearing, type Projection } from "./geo";
import { findMerges } from "./highway";
import type { LonLat, Route } from "./types";

/**
 * What lies ahead on this road: the safety features the server found
 * near the car, kept only where they sit on the route and in front of
 * the car (which is the direction filter the public data cannot give —
 * a camera facing the other carriageway projects onto the route too, but
 * only one of a pair is "ahead" for long, and both are on the same road,
 * so a warning for it costs a driver nothing), plus bends worked out from
 * the route's own shape.
 */
export type Kind =
  | "speed" | "signal" | "speed-signal" | "section-start" | "section-end" | "bump" | "school" | "curve" | "curves" | "accident" | "bike-accident"
  | "school-zone" | "incident-crash" | "incident-work" | "incident-other" | "rest-area" | "merge" | "signal-light" | "senior-zone" | "other";

/** A motorway rest area's station prices and what it has (server/src/road/rest-areas.ts). */
export interface RestInfo {
  route?: string;
  gasoline?: number;
  diesel?: number;
  lpg?: number;
  brand?: string;
  amenities: string[];
}

export interface Feature {
  id: string;
  kind: Kind;
  lon: number;
  lat: number;
  limit?: number;
  name?: string;
  /** An area (an accident hotspot, a school zone): on the route if the route passes within this of its centre. */
  radiusM?: number;
  /** A line under the name for the screen: an incident's road and closed lanes, a school zone's facility. */
  detail?: string;
  rest?: RestInfo;
  /** A traffic light's flashing hours: "00:00-05:00" (KST), or "always". */
  flash?: string;
  /** The road direction code the source gives (경찰청's 도로노선방향: 1, 2, 3 …): a 구간 단속's start and end share it. */
  direction?: string;
  /** A camera inside a 보호구역 (school or senior zone): its limit is the zone's. */
  zone?: "school" | "senior";
  /** A 구간 단속 camera's other end (server/src/safety/index.ts sectionPairs). */
  pair?: LonLat;
  /** The carriageways the camera stands on, the way each runs (server/src/safety/roads.ts). */
  ways?: { deg: number; at: LonLat; lanes?: number | null; name?: string }[];
  /** A camera's 설치장소 ("운천제2교차로 (포천->김화)"). */
  site?: string;
  /** How far before the place its coordinates are the site puts it ("양문사거리전400m지점"): never one camera with another kind there. */
  beforeM?: number;
  /**
   * A speed bump's lane in 정밀도로지도 (server/src/safety/hd-points.ts): the way it runs (−1 where not known) and the
   * bump's place on it. Every HD bump has one; a public bump where the HD map surveyed its road.
   */
  lane?: { deg: number; at: LonLat };
}

/** A feature placed on the route; [with]: whether a carriageway it stands on runs with the route (undefined: none says). */
type Placed = { feature: Feature; alongM: number; endM: number; with?: boolean };

export interface Ahead {
  feature: Feature;
  /** Metres along the route from the start: where an area begins, for an area. */
  alongM: number;
  /** Where an area ends along the route; a point's is its alongM. */
  endM?: number;
  /** Metres between the car and it, along the road. */
  inM: number;
}

/** Features more than this far from the route are on another road. */
export const ON_ROUTE_M = 25;
/**
 * A camera's carriageways (Feature.ways) are read where they are this near the route: one running with it (within
 * WITH_DEG) makes the camera the route's; with none, one running against it (AGAINST_DEG and more) makes it the
 * other way's. The graph is asked in 45° steps (±23°), so a road across the route reads 45–135°, and says neither.
 */
export const OTHER_WAY_M = 30;
export const WITH_DEG = 45;
export const AGAINST_DEG = 135;
/** A 구간 단속 camera with a pair is judged by its pair, not its point, which can sit on the other carriageway's line: this far off is the route's. */
export const SECTION_REACH_M = 40;
/** Speed cameras this near each other along the route with two limits are one warning, the lower (민락: 60 then 50, 77 m on, 2026-10-11). */
export const NEAR_LIMITS_M = 150;
/**
 * A 구간 단속 the route drives without its end camera ends where the route leaves its road: off the motorway stretch
 * the start is on, or — on a road not marked one — this far (or SECTION_OFF_SHARE of the stretch) off the line from
 * its start to its end. 동부간선 southbound ran on into 노원's streets past the 상계교 exit (2026-10-11).
 */
export const SECTION_OFF_M = 150;
const SECTION_OFF_SHARE = 0.1;
/** A 보호구역's street (the road nearest its school) this near the route is the route. */
export const ZONE_ROAD_M = 15;
/** A road this many lanes one way (정밀도로지도) is a main road: a 보호구역 on it shows by its cameras. */
export const WIDE_LANES = 3;
/**
 * Kinds placed further off than a camera: a rest area sits beside the
 * carriageway, and ITS puts an incident on its link's line, which can be
 * the other side of a wide motorway.
 */
const REACH_M: Partial<Record<Kind, number>> = { "rest-area": 250, "incident-crash": 40, "incident-work": 40, "incident-other": 40 };
/**
 * A school zone as a strip of the route, not a circle round the school:
 * the school within SCHOOL_SIDE_M to the side of the road, and the zone
 * SCHOOL_HALF_M either way along it from the point beside the school. A
 * circle caught a road that only passes by (a motorway behind the fence).
 */
export const SCHOOL_SIDE_M = 100;
export const SCHOOL_HALF_M = 150;
/** Kinds that are never on a motorway or car-only road, whatever lies beside one. */
const NOT_ON_MOTORWAYS: Kind[] = ["school-zone", "senior-zone", "bump", "school"];
/**
 * A speed bump is painted on its own lane, not near one: a bump on a lane of the HD map (Feature.lane) is the route's
 * only where the route runs within BUMP_LANE_M of it — the providers' lines keep within 2.5 m of a lane of their road
 * nine times in ten off the motorways (the drives of 2026-10-04 to 10-11) — and not across it (BUMP_ACROSS_DEG; a
 * two-way road's bump may be on the other way's lane, which is still the road's). Within ON_ROUTE_M, as before, a
 * frontage road, a side lane and the other carriageway passed at 70–92 km/h had their bumps said: 10 of 14 on
 * 2026-10-11, 5.6–24 m off. A public bump on a street the HD map has not surveyed keeps ON_ROUTE_M: its place is rough.
 */
export const BUMP_LANE_M = 5;
export const BUMP_ACROSS_DEG = 40;
/**
 * No bump is in an underpass, a tunnel or on an overpass: from a guide that says the route enters one ("왼쪽 지하차도
 * 진입", "고가도로 진입") until the next guide, UNDERPASS_M at most, a bump near the line is the road beside or above.
 * NAVER's line through 만가대 runs on the frontage road over the underpass the car drives, its bumps 1–3 m off it.
 */
export const UNDERPASS_M = 1000;
const ENTERS_UNDER_OR_OVER = /(지하차도|고가차도|고가도로|터널)\s*진입/;
/** The distances at which each kind is spoken (server/src/phrases.ts); a feature is spoken once per rung. */
export const RUNGS_M: Record<Kind, number[]> = WARNING_RUNGS_M;

/** What the driver asked for (guide-settings.ts): which kinds, and cameras from how far. */
export interface WatchPrefs {
  /** Said aloud. */
  wants(kind: Kind): boolean;
  /** Shown on the screen (where the kind has a card or a sign); unset, everything is. */
  shows?(kind: Kind): boolean;
  cameraFromM: number;
}
const ALL: WatchPrefs = { wants: () => true, cameraFromM: 600 };

/** Cameras this close along the route are one camera. */
const CAMERA_TWIN_M = 40;
/** No feature that begins more than this before the car is about it any more (an area runs a few hundred metres). */
const BEHIND_M = 3000;
/** The longest a 구간 단속 is taken to run past its start camera when its end camera is not on the route. */
export const SECTION_MAX_M = 25_000;
const MERGED_CAMERAS = new Set<Kind>(["speed", "signal", "speed-signal"]);
const SPEED_CAMERAS = new Set<Kind>(["speed", "speed-signal"]);
/**
 * Two rows for one camera as one: speed and signal together are a 신호·과속 camera. The first row's id is kept, so
 * what was said of it stays said. The limit is never the first to come (the nearer to where the page asked, 80 one
 * way and 70 the other at 운천제2교차로, 2026-10-11): a speed row's over a signal row's, the row standing on a
 * carriageway that runs with the route over one that says nothing, and of those the lower.
 */
export function mergeCameras(a: Feature, b: Feature, aWith?: boolean, bWith?: boolean): Feature {
  const speed = a.kind !== "signal" || b.kind !== "signal";
  const signal = a.kind !== "speed" || b.kind !== "speed";
  const kind: Kind = speed && signal ? "speed-signal" : speed ? "speed" : "signal";
  let rows = [{ f: a, with: aWith }, { f: b, with: bWith }].filter((r) => r.f.limit != null);
  if (rows.some((r) => r.f.kind !== "signal")) rows = rows.filter((r) => r.f.kind !== "signal");
  if (rows.some((r) => r.with === true)) rows = rows.filter((r) => r.with === true);
  const limit = rows.length ? Math.min(...rows.map((r) => r.f.limit!)) : undefined;
  return { ...a, kind, limit, zone: a.zone ?? b.zone };
}

/** A 구간 단속 camera's direction code, "01" and "1" alike; "" where the source gives none. */
const directionOf = (f: Feature) => (f.direction ?? "").trim().replace(/^0+/, "");
/** A start and an end of two different directions this close together are the two carriageways' cameras at one place. */
const SECTION_TWIN_M = 300;
const metresBetween = (a: LonLat, b: LonLat) => Math.hypot((b[0] - a[0]) * 111_320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180), (b[1] - a[1]) * 111_320);
/** The limits a zone camera can give its zone. */
const ZONE_LIMITS = new Set([20, 30, 40, 50, 60]);

export class RouteWatch {
  private line: Line;
  /** Every feature on the route, sorted by where it is along it. */
  private onRoute: Placed[] = [];
  /** The zone cameras left out as the other carriageway's: still a sign their 보호구역 is this road's (zoneHere). */
  private otherWay: { feature: Feature; alongM: number }[] = [];
  /**
   * @param spoken feature id → the rungs already spoken. Handed on from the
   *   last watch when the same trip is re-routed, so a camera said before the
   *   wrong turn is not said again after it.
   */
  constructor(private route: Route, private prefs: () => WatchPrefs = () => ALL, private spoken = new Map<string, Set<number>>()) {
    this.line = new Line(route.path);
    this.underOrOver = underOrOverStretches(route, this.line);
    for (const c of findCurves(route)) this.place(c);
    for (const m of findMerges(route)) this.place(m);
  }

  /** Takes the server's radius answer; features already known are left alone. */
  add(features: Feature[]) {
    let added = false;
    for (const f of features) {
      // Once each: the ones placed, and the ones placed off the route or merged into a twin — every answer round the
      // car has the same hundreds of lights, and each was projected onto the whole line again.
      if (this.tried.has(f.id)) continue;
      this.tried.add(f.id);
      const n = this.onRoute.length, o = this.otherWay.length;
      this.place(f);
      if (this.onRoute.length !== n || this.otherWay.length !== o) added = true;
    }
    // A new array marks the features changed, for what is cached off them (sections()).
    if (added) this.onRoute = [...this.onRoute];
  }
  private tried = new Set<string>();
  /** Where the route is in an underpass or a tunnel or on an overpass, by its guides: [from, to] metres along it. */
  private underOrOver: [number, number][];

  private place(f: Feature) {
    const at = this.line.project([f.lon, f.lat], 0, this.line.path.length);
    if (NOT_ON_MOTORWAYS.includes(f.kind) && this.onMotorway(at.segment)) return;
    if (f.kind === "bump") {
      this.placeBump(f, at);
      return;
    }
    if (f.kind === "school-zone" || f.kind === "senior-zone") {
      if (at.offM > SCHOOL_SIDE_M) return;
      // Cut where a motorway begins or ends: a 어린이집 by the road onto one had its zone run 150 m up the motorway.
      let from = Math.max(0, at.alongM - SCHOOL_HALF_M), to = at.alongM + SCHOOL_HALF_M;
      for (const [a, b] of this.route.motorways ?? []) {
        const starts = this.line.along[a], ends = this.line.along[Math.min(b, this.line.along.length - 1)];
        if (starts >= at.alongM && starts < to) to = starts;
        if (ends <= at.alongM && ends > from) from = ends;
      }
      this.onRoute.push({ feature: f, alongM: from, endM: to });
      this.onRoute.sort((a, b) => a.alongM - b.alongM);
      return;
    }
    // A 구간 단속 camera with its pair is judged by the pair (sectionPlan), not by the carriageway its point is on:
    // 동부간선's southbound start (상계, J8831) sits on the northbound line, 23 m off the southbound route, its way
    // the northbound one — and was left out going south (2026-10-11).
    const paired = (f.kind === "section-start" || f.kind === "section-end") && !!f.pair;
    const reach = Math.max(REACH_M[f.kind] ?? (paired ? SECTION_REACH_M : ON_ROUTE_M), f.radiusM ?? 0);
    let p = at;
    // A camera the list puts off its road (구리포천고속도로's G5870, 143 m off) is where the server put it on its
    // road (roads.ts, a road of its name), if that road is the route and runs the route's way there.
    if (p.offM > reach && f.ways?.length) {
      for (const w of f.ways) {
        if (w.deg < 0) continue;
        const q = this.line.project(w.at, 0, this.line.path.length);
        if (q.offM <= ON_ROUTE_M && q.offM < p.offM && angleBetween(q.bearing, w.deg) <= WITH_DEG) p = q;
      }
    }
    if (p.offM > reach) return;
    // The other way's camera is not the route's: none of the carriageways it stands on runs with the route and one
    // runs against it (강변북로 westbound, beside the ramp east onto 청담대교, 2026-10-04). A camera at a junction
    // put on the cross street too — 운천제2교차로's northbound camera, on 호국로 and a side road — is still the other
    // way's (2026-10-11); one put on the cross street alone says nothing either way, and is kept.
    const runs = this.runsWith(f, p);
    if (runs === false && !paired) {
      if (f.zone) this.otherWay.push({ feature: f, alongM: p.alongM });
      return;
    }
    // One camera, one warning: a 신호·과속 camera the lists give as two rows (a speed one and a signal one,
    // or the same one from two sources) was said twice at once, "과속 단속 … 오십" and "신호 단속" together.
    // Not a camera its site puts N m before the junction (양문사거리전400m지점, at the junction's signal camera's
    // very point): it is not that camera, wherever the list puts it.
    if (MERGED_CAMERAS.has(f.kind)) {
      const twin = this.onRoute.find((o) => MERGED_CAMERAS.has(o.feature.kind) && Math.abs(o.alongM - p.alongM) <= CAMERA_TWIN_M
        && !(o.feature.kind !== f.kind && (o.feature.beforeM || f.beforeM)));
      if (twin) {
        twin.feature = mergeCameras(twin.feature, f, twin.with, runs);
        twin.with = twin.with || runs;
        return;
      }
      // Two speed cameras a few seconds apart with two limits (민락: "육백 … 육십", then "육백 … 오십" 11 s later, and
      // the limit shown turning 60 → 50, 2026-10-11): one warning, at the first, with the lower limit.
      if (SPEED_CAMERAS.has(f.kind) && f.limit) {
        const near = this.onRoute.find((o) => SPEED_CAMERAS.has(o.feature.kind) && o.feature.limit && o.feature.limit !== f.limit && Math.abs(o.alongM - p.alongM) <= NEAR_LIMITS_M);
        if (near) {
          near.feature = { ...mergeCameras(near.feature, f), limit: Math.min(near.feature.limit!, f.limit) };
          near.alongM = near.endM = Math.min(near.alongM, p.alongM);
          near.with = near.with || runs;
          this.onRoute.sort((a, b) => a.alongM - b.alongM);
          return;
        }
      }
    }
    // A rest area on the left is the other carriageway's (Korea drives on the right).
    if (f.kind === "rest-area" && p.offM > 30 && sideOf(p.bearing, bearing(p.at[0], p.at[1], f.lon, f.lat)) < 0) return;
    // An area begins where the route enters its circle, and ends where it leaves.
    const half = f.radiusM ? Math.sqrt(Math.max(0, f.radiusM ** 2 - p.offM ** 2)) : 0;
    this.onRoute.push({ feature: f, alongM: Math.max(0, p.alongM - half), endM: p.alongM + half, with: runs });
    this.onRoute.sort((a, b) => a.alongM - b.alongM);
  }

  /** A speed bump: on the route's own lane (BUMP_LANE_M, BUMP_ACROSS_DEG) where the HD map has its lane; never under or over. */
  private placeBump(f: Feature, at: Projection) {
    let p = at;
    if (f.lane) {
      p = this.line.project(f.lane.at, Math.max(0, at.segment - 5), 12);
      if (p.offM > BUMP_LANE_M) return;
      if (f.lane.deg >= 0) {
        const deg = angleBetween(p.bearing, f.lane.deg);
        if (Math.min(deg, 180 - deg) > BUMP_ACROSS_DEG) return;
      }
    } else if (p.offM > ON_ROUTE_M) return;
    if (this.underOrOver.some(([from, to]) => p.alongM >= from && p.alongM <= to)) return;
    this.onRoute.push({ feature: f, alongM: p.alongM, endM: p.alongM });
    this.onRoute.sort((a, b) => a.alongM - b.alongM);
  }

  /**
   * Whether the camera's carriageways near the route ([p], where it is on it) say it is the route's: true where one
   * runs with the route, false where none does and one runs against it, undefined where none says (no ways, or
   * only a road across).
   */
  private runsWith(f: Feature, p: { segment: number }): boolean | undefined {
    let against = false;
    for (const w of f.ways ?? []) {
      if (w.deg < 0) continue;
      const q = this.line.project(w.at, Math.max(0, p.segment - 5), 12);
      if (q.offM > OTHER_WAY_M) continue;
      const deg = angleBetween(q.bearing, w.deg);
      if (deg <= WITH_DEG) return true;
      if (deg >= AGAINST_DEG) against = true;
    }
    return against ? false : undefined;
  }

  /** Whether the route's segment [i] (from vertex i to i + 1) is on a motorway. */
  private onMotorway(i: number): boolean {
    return !!this.route.motorways?.some(([from, to]) => i >= from && i < to);
  }

  /** The protected zones on the route (school, senior), each as the stretch of it they cover. */
  zones(): { feature: Feature; alongM: number; endM: number }[] {
    return this.onRoute.filter((f) => (f.feature.kind === "school-zone" || f.feature.kind === "senior-zone") && this.zoneHere(f));
  }

  /**
   * Whether a 보호구역 near the route is on it: its school's street is the route (the road nearest the school,
   * Feature.ways, within ZONE_ROAD_M of the line), or a camera of the zone stands on the route by it. A 어린이집 36 m
   * off 양재대로 has its zone on the lane its gate is on, not on the eight lanes of 양재대로 (2026-10-04, warned twice).
   * A zone the server could not put on a road is taken as before.
   */
  /**
   * The first feature that can still be about [alongM]: none that begins more than BEHIND_M before it ends after it
   * (a zone, a hotspot: a few hundred metres). Asked ten times a second, from the route's start the scan grew with
   * every kilometre driven — thousands of lights and bumps behind the car — and the page slowed through a long drive.
   */
  private firstNear(alongM: number): number {
    const from = alongM - BEHIND_M;
    let lo = 0, hi = this.onRoute.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.onRoute[mid].alongM < from) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** zoneHere's answers, kept while the features stay the same (it projects onto the whole line). */
  private zonesKnown = new Map<string, boolean>();
  private zonesOf: unknown = null;
  private zoneHere(z: { feature: Feature; alongM: number; endM: number }): boolean {
    if (this.zonesOf !== this.onRoute) { this.zonesKnown.clear(); this.zonesOf = this.onRoute; }
    let here = this.zonesKnown.get(z.feature.id);
    if (here === undefined) this.zonesKnown.set(z.feature.id, (here = this.zoneHereNow(z)));
    return here;
  }
  private zoneHereNow(z: { feature: Feature; alongM: number; endM: number }): boolean {
    const way = z.feature.ways?.[0];
    if (!way) return true;
    const zone = z.feature.kind === "school-zone" ? "school" : "senior";
    // A camera of the zone on the route by it — or on the other carriageway by it: 영중초's camera on 호국로 faces
    // north, and going south the zone was not said (2026-10-11), though it is the road's both ways.
    const by = (f: { feature: Feature; alongM: number }) => f.feature.zone === zone && f.alongM >= z.alongM - 50 && f.alongM <= z.endM + 50;
    const camera = () => this.onRoute.some(by) || this.otherWay.some(by);
    if (this.line.project(way.at, 0, this.line.path.length).offM > ZONE_ROAD_M) return camera();
    // Its street the route — but the road graph has no alleys, and a school by a main road is put on it whatever
    // street its gate is on (예지어린이집 by 양재대로, on the 2-lane side road over its underpass): on a 대로 (by the
    // road-name rules eight lanes and more) or a road of WIDE_LANES one way, only a camera of the zone on the route
    // says the zone is the road's.
    const main = /대로$/.test(way.name ?? "") || (way.lanes ?? 0) >= WIDE_LANES;
    return main ? camera() : true;
  }

  /**
   * The 구간 단속 stretches on the route: from each start camera to the end camera after it. Without one (the route
   * leaves by an exit before it, or the end camera is still beyond the radius asked for) the stretch runs on for
   * SECTION_MAX_M at most, not to the destination. Kept until the features change: asked every frame.
   */
  sections(): { feature: Feature; alongM: number; endM: number }[] {
    return this.sectionPlan().sections;
  }

  /**
   * The 구간 단속 stretches, and the section cameras that are the other way's. A two-way road has one stretch each
   * way, the start of one by the end of the other: a stretch begins at a start camera only where the route heads
   * for that camera's end (Feature.pair, the server's pairing) and runs to it — to the end camera where the route
   * passes it, or where the route comes nearest it and turns off. On 2026-10-04 the start camera of 동부간선's
   * northbound stretch (면목, its end at 상계 6 km north) was passed going south, and the stretch ran on for the
   * route's last 20 km. A camera with no pair is read by direction code and order, as before.
   */
  private sectionPlan(): { sections: { feature: Feature; alongM: number; endM: number }[]; silent: Set<string> } {
    if (this.sectionsOf === this.onRoute) return this.sectionsKnown;
    const sections: { feature: Feature; alongM: number; endM: number }[] = [];
    const silent = new Set<string>();
    const cams = this.onRoute.filter((f) => f.feature.kind === "section-start" || f.feature.kind === "section-end");
    const dist = (along: number, to: LonLat) => metresBetween(this.line.place(Math.max(0, Math.min(this.line.lengthM, along))).at, to);
    /** Whether the route at [along] goes toward [to] (+1), away from it (-1), or neither clearly. */
    const heading = (along: number, to: LonLat) => {
      const step = Math.min(500, Math.max(100, dist(along, to) / 3));
      const before = dist(along - step, to), after = dist(along + step, to);
      return after < before - step * 0.3 ? 1 : after > before + step * 0.3 ? -1 : 0;
    };
    // First the stretches the route drives whole: a start, then the end of its direction code after it.
    const used = new Set<(typeof cams)[number]>();
    for (const end of cams) {
      if (end.feature.kind !== "section-end") continue;
      const start = cams.filter((s) => s.feature.kind === "section-start" && !used.has(s) && directionOf(s.feature) === directionOf(end.feature)
        && s.alongM < end.alongM && end.alongM - s.alongM <= SECTION_MAX_M).pop();
      if (!start) continue;
      used.add(start); used.add(end);
      sections.push({ feature: start.feature, alongM: start.alongM, endM: end.alongM });
    }
    for (const f of cams) {
      if (used.has(f)) continue;
      const dir = directionOf(f.feature), pair = f.feature.pair;
      if (f.feature.kind === "section-start") {
        // Its end not on the route. Its pair behind (the other way's stretch — 동부간선 northbound's start passed going
        // south on 2026-10-04, which ran on for the route's last 20 km), or an end of its direction behind it: unsaid.
        const away = pair ? heading(f.alongM, pair) === -1 : false;
        const reversed = dir !== "" && cams.some((e) => e.feature.kind === "section-end" && !used.has(e) && directionOf(e.feature) === dir && e.alongM < f.alongM - SECTION_TWIN_M && f.alongM - e.alongM <= SECTION_MAX_M);
        if (away || reversed) { silent.add(f.feature.id); continue; }
        // To where the route comes nearest its end and turns off; without a pair, SECTION_MAX_M at most.
        let endM = Math.min(this.line.lengthM, f.alongM + SECTION_MAX_M);
        if (pair) {
          let nearest = Infinity;
          // Not past where the route leaves the stretch's road, however much nearer its end the streets beyond go.
          const last = Math.min(endM, this.leavesStretch(f.alongM, pair));
          for (let m = f.alongM; m <= last; m += 25) {
            const d = dist(m, pair);
            if (d < nearest) { nearest = d; endM = m; }
            else if (d > nearest + 2000) break;
          }
          // Still nearing it where the route leaves the road: to there.
          if (last < Infinity && endM + 25 > last && dist(last, pair) <= nearest) endM = last;
          // A route that never comes much nearer its end does not drive the stretch: going east past 영동고속도로's
          // westbound start (151.5 km, its end at 144.8 km), the heading read neither way across the bend, and a
          // stretch of 250 m opened and closed (2026-10-05).
          // (One that clearly heads for it and turns off early still drives the start of it.)
          const from = dist(f.alongM, pair);
          if (heading(f.alongM, pair) !== 1 && nearest > Math.max(SECTION_TWIN_M, from * 0.5)) { silent.add(f.feature.id); continue; }
        }
        sections.push({ feature: f.feature, alongM: f.alongM, endM });
      } else {
        // An end with no start before it: the other way's — its start ahead, or beside a start of another direction —
        // or this one's, the car having joined the stretch partway (then it is said).
        const toward = pair ? heading(f.alongM, pair) === 1 : false;
        const twin = cams.some((s) => s.feature.kind === "section-start" && directionOf(s.feature) !== dir && Math.abs(s.alongM - f.alongM) <= SECTION_TWIN_M);
        const reversed = dir !== "" && cams.some((s) => s.feature.kind === "section-start" && !used.has(s) && directionOf(s.feature) === dir && s.alongM > f.alongM + SECTION_TWIN_M && s.alongM - f.alongM <= SECTION_MAX_M);
        if (toward || twin || reversed) silent.add(f.feature.id);
      }
    }
    sections.sort((a, b) => a.alongM - b.alongM);
    this.sectionsOf = this.onRoute;
    this.sectionsKnown = { sections, silent };
    return this.sectionsKnown;
  }
  private sectionsOf: unknown = null;

  /**
   * Where the route leaves the road of a 구간 단속 that begins at [fromM] and ends at [pair]: the end of the motorway
   * stretch it begins on (stretches a short ramp apart taken as one), or, off the motorways, where the route is
   * further from the line between its start and its end than SECTION_OFF_M (or SECTION_OFF_SHARE of the stretch,
   * for a road that bends). Infinity where it does not.
   */
  private leavesStretch(fromM: number, pair: LonLat): number {
    const along = this.line.along;
    // The segment [fromM] is on: the last vertex at or before it.
    let lo = 0, hi = along.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (along[mid] <= fromM) lo = mid; else hi = mid - 1;
    }
    const seg = lo;
    const stretches = [...(this.route.motorways ?? [])].sort((a, b) => a[0] - b[0]);
    const k = stretches.findIndex(([a, b]) => seg >= a && seg < b);
    if (k >= 0) {
      let end = stretches[k][1];
      for (let j = k + 1; j < stretches.length && along[Math.min(stretches[j][0], along.length - 1)] - along[Math.min(end, along.length - 1)] < 300; j++) end = Math.max(end, stretches[j][1]);
      return end >= along.length - 1 ? Infinity : along[end];
    }
    const a = this.line.place(fromM).at;
    const kx = 111_320 * Math.cos((a[1] * Math.PI) / 180), ky = 111_320;
    const ex = (pair[0] - a[0]) * kx, ey = (pair[1] - a[1]) * ky;
    const len = Math.hypot(ex, ey);
    if (len < 1) return Infinity;
    const allowed = Math.max(SECTION_OFF_M, len * SECTION_OFF_SHARE);
    for (let m = fromM; m <= this.line.lengthM; m += 25) {
      const q = this.line.place(m).at;
      const x = (q[0] - a[0]) * kx, y = (q[1] - a[1]) * ky;
      const s = Math.max(0, Math.min(1, (x * ex + y * ey) / (len * len)));
      if (Math.hypot(x - s * ex, y - s * ey) > allowed) return m;
      if (s >= 1) return Infinity;
    }
    return Infinity;
  }
  private sectionsKnown: { sections: { feature: Feature; alongM: number; endM: number }[]; silent: Set<string> } = { sections: [], silent: new Set() };

  /**
   * A 보호구역's limit on this route: a camera of that zone on the route within it (or just by it) says it — the
   * road this route takes past the school, not the 50 arterial at its front when the route goes by the 30 lane at
   * its back. Without one, the server's (its cameras round it, all agreeing), or none.
   */
  private zoneLimit(z: { feature: Feature; alongM: number; endM: number }): number | undefined {
    const zone = z.feature.kind === "school-zone" ? "school" : z.feature.kind === "senior-zone" ? "senior" : null;
    if (!zone) return z.feature.limit;
    const of = (f: { feature: Feature; alongM: number }) => f.feature.zone === zone && f.feature.limit && ZONE_LIMITS.has(f.feature.limit) && f.alongM >= z.alongM - 50 && f.alongM <= z.endM + 50;
    // The route's own camera first; the other carriageway's (the zone the same both ways) where it has none.
    const cam = this.onRoute.find(of) ?? this.otherWay.find(of);
    return cam?.feature.limit ?? z.feature.limit;
  }

  /** The 구간 단속 the car is currently inside, if any. */
  currentSection(alongM: number): { feature: Feature; startAlongM: number; endAlongM: number; limit: number } | null {
    for (const s of this.sections()) {
      if (alongM >= s.alongM && alongM <= s.endM && s.feature.limit) {
        return { feature: s.feature, startAlongM: s.alongM, endAlongM: s.endM, limit: s.feature.limit };
      }
    }
    return null;
  }

  /** Forgets the features of [kinds] (an incident list asked again: the cleared ones go). */
  drop(kinds: Kind[]) {
    this.onRoute = this.onRoute.filter((f) => !kinds.includes(f.feature.kind));
  }

  /** Everything ahead of [alongM] within [horizonM], nearest first; an area stays while the car is in it. */
  ahead(alongM: number, horizonM = 1000): Ahead[] {
    const out: Ahead[] = [];
    const silent = this.sectionPlan().silent;
    for (let i = this.firstNear(alongM); i < this.onRoute.length; i++) {
      const f = this.onRoute[i];
      const inM = f.alongM - alongM;
      if (inM < -10 && f.endM < alongM) continue;
      if (inM > horizonM) break;
      // The other carriageway's 구간 단속 cameras are not ahead of this car, whatever the line they project onto.
      if (silent.has(f.feature.id)) continue;
      const zone = f.feature.kind === "school-zone" || f.feature.kind === "senior-zone";
      if (zone && !this.zoneHere(f)) continue;
      out.push({ feature: zone ? { ...f.feature, limit: this.zoneLimit(f) } : f.feature, alongM: f.alongM, endM: f.endM, inM });
    }
    return out;
  }

  /**
   * The warnings due now: features whose next rung the car has just
   * crossed. Each rung fires once; a re-route makes a new watch.
   */
  due(alongM: number): (Ahead & { rungM: number; voice: boolean })[] {
    const out: (Ahead & { rungM: number; voice: boolean })[] = [];
    const prefs = this.prefs();
    for (const a of this.ahead(alongM, 2100)) {
      // Said, or only shown (a card that comes at the same moment the sentence would have).
      const voice = prefs.wants(a.feature.kind);
      if (!voice && !(prefs.shows?.(a.feature.kind) ?? false)) continue;
      // A traffic light is only a warning while it flashes; left unsaid, so a later pass at night still speaks.
      if (a.feature.kind === "signal-light" && !flashingNow(a.feature)) continue;
      const rungs = this.rungsOf(a.feature.kind, prefs);
      const done = this.spoken.get(a.feature.id) ?? new Set<number>();
      // Of the rungs the car is inside, the nearest not yet said — and saying it marks the further ones said
      // too: a camera first learned of at 250 m (the server's answer came late) is "300미터 앞", not "600미터 앞"
      // and then "300미터 앞" a second later. One rung per feature per call; the next comes on a later call.
      // Behind the car already (a camera the server's answer named after it was passed; a zone the drive began
      // inside): nothing to say of it — "삼백미터 앞에…" would be wrong — and its rungs are over.
      if (a.inM < 0) {
        for (const r of rungs) done.add(r);
        this.spoken.set(a.feature.id, done);
        continue;
      }
      const inside = rungs.filter((r) => a.inM <= r && !done.has(r));
      if (inside.length === 0) continue;
      const rung = Math.min(...inside);
      for (const r of rungs) if (r >= rung) done.add(r);
      this.spoken.set(a.feature.id, done);
      out.push({ ...a, rungM: rung, voice });
    }
    return out;
  }

  /** Every sentence the warnings ahead within [horizonM] can say, at each of their rungs: for the voice to fetch ahead. */
  phrasesAhead(alongM: number, horizonM: number): string[] {
    const prefs = this.prefs();
    const out: string[] = [];
    for (const a of this.ahead(alongM, horizonM)) {
      if (!prefs.wants(a.feature.kind)) continue;
      for (const r of this.rungsOf(a.feature.kind, prefs)) out.push(phraseFor({ ...a, rungM: r }));
    }
    return out;
  }

  private rungsOf(kind: Kind, prefs: WatchPrefs): number[] {
    return CAMERA_KINDS.includes(kind) ? cameraRungs(prefs.cameraFromM) : RUNGS_M[kind];
  }

  /**
   * The limit the car is held to at [alongM], if any: inside a 구간 단속
   * (past its start, before its end), or with a camera that has a limit
   * ahead within the distance its warning starts at — the stretches where
   * the car apps turn the speed red. Null where no camera says.
   */
  limitAt(alongM: number): { limit: number; why: "section" | "camera" | "school"; inM?: number; id?: string } | null {
    const section: number | null = this.currentSection(alongM)?.limit ?? null;
    let school: number | null = null;
    const prefs = this.prefs();
    for (let i = this.firstNear(alongM); i < this.onRoute.length; i++) {
      const f = this.onRoute[i];
      if (f.alongM > alongM) break;
      // Inside a school zone the limit holds whatever a camera says — the zone's own, where it has one.
      const limit = (f.feature.kind === "school-zone" || f.feature.kind === "senior-zone") && this.zoneHere(f) ? this.zoneLimit(f) : undefined;
      if (limit && f.endM >= alongM && (prefs.shows?.(f.feature.kind) ?? true)) school = Math.min(school ?? Infinity, limit);
    }
    if (school != null) return { limit: school, why: "school" };
    const from = this.prefs().cameraFromM;
    let camera: { limit: number; inM: number; id: string } | null = null;
    for (const a of this.ahead(alongM, from)) {
      const k = a.feature.kind;
      if (a.feature.limit && (k === "speed" || k === "speed-signal" || k === "school" || k === "section-start")) {
        camera = { limit: a.feature.limit, inM: a.inM, id: a.feature.id };
        break;
      }
    }
    if (section != null && (!camera || section <= camera.limit)) return { limit: section, why: "section" };
    return camera ? { limit: camera.limit, why: "camera", inM: camera.inM, id: camera.id } : null;
  }
}

/** Bearing change over this many metres counts as a bend, not a lane wobble. */
const CURVE_WINDOW_M = 40;
const CURVE_DEG = 35;
/** A bend within this far of a turn guide *is* the turn. */
const GUIDE_M = 60;
/**
 * A change made almost all at one vertex is a kink where two ways meet (a
 * junction, a road that jogs), not a bend: a real one is drawn as an arc.
 */
const KINK_SHARE = 0.8;
/** Bends closer together than this are one winding stretch, said once. */
export const CURVE_MERGE_M = 500;

/**
 * Bends in the route: where the road's direction changes by more than
 * CURVE_DEG within CURVE_WINDOW_M, spread over the arc rather than at one
 * vertex, away from any turn guide (a turn is announced already). A run of
 * bends each within CURVE_MERGE_M of the last becomes one "curves" feature
 * at its start — 연속 급커브, once — so a winding road is not a warning
 * every hundred metres.
 */
export function findCurves(route: Route): Feature[] {
  const line = new Line(route.path);
  const guidesAlong = route.guides.map((g) => line.project(g.at, 0, route.path.length).alongM);
  const bends: { i: number; along: number; turn: number }[] = [];
  let lastBendAlong = -Infinity;
  const n = route.path.length;
  for (let i = 1; i < n - 1; i++) {
    // The bearing into vertex i, and out of the vertex CURVE_WINDOW_M on.
    const bIn = segBearing(line, i - 1);
    let j = i;
    while (j < n - 1 && line.along[j] - line.along[i] < CURVE_WINDOW_M) j++;
    if (j >= n - 1) break;
    const bOut = segBearing(line, j);
    const turn = angleBetween(bIn, bOut);
    if (turn < CURVE_DEG) continue;
    const at = line.along[i];
    if (at - lastBendAlong < CURVE_WINDOW_M * 2) continue;
    if (guidesAlong.some((g) => Math.abs(g - at) < GUIDE_M)) continue;
    // The sharpest single vertex in the window: if it carries nearly all of the change, a kink.
    let sharpest = 0;
    for (let k = i; k <= j; k++) sharpest = Math.max(sharpest, angleBetween(segBearing(line, k - 1), segBearing(line, k)));
    if (sharpest >= turn * KINK_SHARE) continue;
    lastBendAlong = at;
    bends.push({ i, along: at, turn });
  }
  const out: Feature[] = [];
  for (let k = 0; k < bends.length; ) {
    let end = k;
    while (end + 1 < bends.length && bends[end + 1].along - bends[end].along < CURVE_MERGE_M) end++;
    const first = bends[k];
    const [lon, lat] = route.path[first.i];
    const many = end > k;
    // Named by its place, not its vertex: a re-route keeps what was said, and the same vertex number on the new
    // line is another bend.
    out.push({ id: `curve:${lon.toFixed(4)},${lat.toFixed(4)}`, kind: many ? "curves" : "curve", lon, lat, name: many ? `${end - k + 1}곳` : `${Math.round(first.turn)}°` });
    k = end + 1;
  }
  return out;
}

/**
 * The stretches of [route] in an underpass, a tunnel or on an overpass: from each guide that says the route enters one
 * to the next guide, UNDERPASS_M at most.
 */
export function underOrOverStretches(route: Route, line = new Line(route.path)): [number, number][] {
  const out: [number, number][] = [];
  const along = route.guides.map((g) => line.project(g.at, 0, line.path.length).alongM);
  route.guides.forEach((g, i) => {
    if (!ENTERS_UNDER_OR_OVER.test(g.text)) return;
    const next = along.slice(i + 1).find((m) => m > along[i]) ?? Infinity;
    out.push([along[i], Math.min(along[i] + UNDERPASS_M, next)]);
  });
  return out;
}

function segBearing(line: Line, i: number): number {
  const dx = line.xs[i + 1] - line.xs[i];
  const dy = line.ys[i + 1] - line.ys[i];
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** Whether a traffic light is flashing at [now] (Korean time): its night hours, which may run past midnight, or always. */
export function flashingNow(f: Pick<Feature, "flash">, now = Date.now()): boolean {
  if (!f.flash) return false;
  if (f.flash === "always") return true;
  const m = f.flash.match(/^(\d\d):(\d\d)-(\d\d):(\d\d)$/);
  if (!m) return false;
  const kst = new Date(now + 9 * 3600_000);
  const t = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const from = Number(m[1]) * 60 + Number(m[2]), to = Number(m[3]) * 60 + Number(m[4]);
  return from < to ? t >= from && t < to : t >= from || t < to;
}

/** Which side of a road running [roadDeg] a point at [toDeg] from it is: + right, − left. */
function sideOf(roadDeg: number, toDeg: number): number {
  return Math.sin(((toDeg - roadDeg) * Math.PI) / 180);
}

/** What the voice says for one due warning: a fixed sentence (server/src/phrases.ts), rendered ahead of time. */
export function phraseFor(w: Ahead & { rungM: number }): string {
  return warningPhrase(w.feature.kind, w.rungM, w.feature.limit);
}

export function keyOf(at: LonLat): string {
  return `${at[0].toFixed(3)},${at[1].toFixed(3)}`;
}
