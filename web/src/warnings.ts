import { CAMERA_KINDS, WARNING_RUNGS_M, cameraRungs, warningPhrase } from "../../server/src/phrases";
import { Line, angleBetween, bearing } from "./geo";
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
}

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
/** The longest a 구간 단속 is taken to run past its start camera when its end camera is not on the route. */
export const SECTION_MAX_M = 25_000;
const MERGED_CAMERAS = new Set<Kind>(["speed", "signal", "speed-signal"]);
/** Two rows for one camera as one: speed and signal together are a 신호·과속 camera; the limit is whichever says one. The first row's id is kept, so what was said of it stays said. */
function mergeCameras(a: Feature, b: Feature): Feature {
  const speed = a.kind !== "signal" || b.kind !== "signal";
  const signal = a.kind !== "speed" || b.kind !== "speed";
  const kind: Kind = speed && signal ? "speed-signal" : speed ? "speed" : "signal";
  return { ...a, kind, limit: a.limit ?? b.limit };
}

export class RouteWatch {
  private line: Line;
  /** Every feature on the route, sorted by where it is along it. */
  private onRoute: { feature: Feature; alongM: number; endM: number }[] = [];
  /**
   * @param spoken feature id → the rungs already spoken. Handed on from the
   *   last watch when the same trip is re-routed, so a camera said before the
   *   wrong turn is not said again after it.
   */
  constructor(private route: Route, private prefs: () => WatchPrefs = () => ALL, private spoken = new Map<string, Set<number>>()) {
    this.line = new Line(route.path);
    for (const c of findCurves(route)) this.place(c);
    for (const m of findMerges(route)) this.place(m);
  }

  /** Takes the server's radius answer; features already known are left alone. */
  add(features: Feature[]) {
    const known = new Set(this.onRoute.map((f) => f.feature.id));
    let added = false;
    for (const f of features) if (!known.has(f.id)) { this.place(f); added = true; }
    // A new array marks the features changed, for what is cached off them (sections()).
    if (added) this.onRoute = [...this.onRoute];
  }

  private place(f: Feature) {
    const p = this.line.project([f.lon, f.lat], 0, this.line.path.length);
    if (NOT_ON_MOTORWAYS.includes(f.kind) && this.onMotorway(p.segment)) return;
    if (f.kind === "school-zone" || f.kind === "senior-zone") {
      if (p.offM > SCHOOL_SIDE_M) return;
      // Cut where a motorway begins or ends: a 어린이집 by the road onto one had its zone run 150 m up the motorway.
      let from = Math.max(0, p.alongM - SCHOOL_HALF_M), to = p.alongM + SCHOOL_HALF_M;
      for (const [a, b] of this.route.motorways ?? []) {
        const starts = this.line.along[a], ends = this.line.along[Math.min(b, this.line.along.length - 1)];
        if (starts >= p.alongM && starts < to) to = starts;
        if (ends <= p.alongM && ends > from) from = ends;
      }
      this.onRoute.push({ feature: f, alongM: from, endM: to });
      this.onRoute.sort((a, b) => a.alongM - b.alongM);
      return;
    }
    if (p.offM > Math.max(REACH_M[f.kind] ?? ON_ROUTE_M, f.radiusM ?? 0)) return;
    // One camera, one warning: a 신호·과속 camera the lists give as two rows (a speed one and a signal one,
    // or the same one from two sources) was said twice at once, "과속 단속 … 오십" and "신호 단속" together.
    if (MERGED_CAMERAS.has(f.kind)) {
      const twin = this.onRoute.find((o) => MERGED_CAMERAS.has(o.feature.kind) && Math.abs(o.alongM - p.alongM) <= CAMERA_TWIN_M);
      if (twin) { twin.feature = mergeCameras(twin.feature, f); return; }
    }
    // A rest area on the left is the other carriageway's (Korea drives on the right).
    if (f.kind === "rest-area" && p.offM > 30 && sideOf(p.bearing, bearing(p.at[0], p.at[1], f.lon, f.lat)) < 0) return;
    // An area begins where the route enters its circle, and ends where it leaves.
    const half = f.radiusM ? Math.sqrt(Math.max(0, f.radiusM ** 2 - p.offM ** 2)) : 0;
    this.onRoute.push({ feature: f, alongM: Math.max(0, p.alongM - half), endM: p.alongM + half });
    this.onRoute.sort((a, b) => a.alongM - b.alongM);
  }

  /** Whether the route's segment [i] (from vertex i to i + 1) is on a motorway. */
  private onMotorway(i: number): boolean {
    return !!this.route.motorways?.some(([from, to]) => i >= from && i < to);
  }

  /** The protected zones on the route (school, senior), each as the stretch of it they cover. */
  zones(): { feature: Feature; alongM: number; endM: number }[] {
    return this.onRoute.filter((f) => f.feature.kind === "school-zone" || f.feature.kind === "senior-zone");
  }

  /**
   * The 구간 단속 stretches on the route: from each start camera to the end camera after it. Without one (the route
   * leaves by an exit before it, or the end camera is still beyond the radius asked for) the stretch runs on for
   * SECTION_MAX_M at most, not to the destination. Kept until the features change: asked every frame.
   */
  sections(): { feature: Feature; alongM: number; endM: number }[] {
    if (this.sectionsOf === this.onRoute) return this.sectionsKnown;
    const out: { feature: Feature; alongM: number; endM: number }[] = [];
    let open: { feature: Feature; alongM: number; endM: number } | null = null;
    for (const f of this.onRoute) {
      if (f.feature.kind === "section-start" && !open) open = { feature: f.feature, alongM: f.alongM, endM: Math.min(this.line.lengthM, f.alongM + SECTION_MAX_M) };
      else if (f.feature.kind === "section-end" && open) { open.endM = f.alongM; out.push(open); open = null; }
    }
    if (open) out.push(open);
    this.sectionsOf = this.onRoute;
    this.sectionsKnown = out;
    return out;
  }
  private sectionsOf: unknown = null;
  private sectionsKnown: { feature: Feature; alongM: number; endM: number }[] = [];

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
    for (const f of this.onRoute) {
      const inM = f.alongM - alongM;
      if (inM < -10 && f.endM < alongM) continue;
      if (inM > horizonM) break;
      out.push({ feature: f.feature, alongM: f.alongM, endM: f.endM, inM });
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
    let section: number | null = null;
    let school: number | null = null;
    const prefs = this.prefs();
    for (const f of this.onRoute) {
      if (f.alongM > alongM) break;
      // Past its start by more than a section can be long: its end camera is not on this route (sections()).
      if (f.feature.kind === "section-start" && f.feature.limit) section = alongM - f.alongM <= SECTION_MAX_M ? f.feature.limit : null;
      if (f.feature.kind === "section-end") section = null;
      // Inside a school zone the limit holds whatever a camera says.
      if ((f.feature.kind === "school-zone" || f.feature.kind === "senior-zone") && f.feature.limit && f.endM >= alongM && (prefs.shows?.(f.feature.kind) ?? true)) {
        school = Math.min(school ?? Infinity, f.feature.limit);
      }
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
    out.push({ id: `curve:${first.i}`, kind: many ? "curves" : "curve", lon, lat, name: many ? `${end - k + 1}곳` : `${Math.round(first.turn)}°` });
    k = end + 1;
  }
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
