import { Line, metres } from "./geo";
import { RouteWatch, type Feature, type WatchPrefs } from "./warnings";
import type { LonLat, Route } from "./types";

/**
 * 안전운전 모드: driving with no route, the cameras, 구간 단속 and 보호구역 on the road ahead are warned of as on a
 * route — what TMAP and Kakao call 안전운전. The server follows the road the car is on from where it is
 * (server/src/road/ahead.ts); the way the car came is put before it, so a 구간 단속 begun a few kilometres back is
 * still the one it is in. A route watch (warnings.ts) over that line does the rest, as it does for a route: when to say
 * what, the limit held to, the other carriageway's cameras left out. The line is asked again when the car leaves it
 * (a turn) or nears its end.
 */

export interface RoadAhead {
  path: LonLat[] | null;
  motorways?: [number, number][];
}

export interface SafeDeps {
  /** The road ahead of [at] heading [deg] (GET /api/road/ahead). */
  ahead(at: LonLat, deg: number, lengthM: number): Promise<RoadAhead>;
  /** The cameras, zones and the rest round [at] (GET /api/safety/near). */
  near(at: LonLat): Promise<Feature[]>;
  prefs(): WatchPrefs;
  log(text: string): void;
  now?(): number;
}

/** The road asked for this far ahead; again once this little of it is left in front of the car. */
export const AHEAD_M = 2500;
const LEFT_M = 900;
/** The car is off the line this far from it, or heading this far from its way (a turn taken). */
const OFF_M = 35;
const TURNED_DEG = 60;
/** Moving: a heading worth following. Slower, the line is kept as it is. */
const MOVING_MPS = 3;
/** The road ahead asked no oftener than this (a car off every road would ask at every check). */
const ASK_EVERY_MS = 3000;
/** The way behind the car kept this long (a 구간 단속 runs up to 25 km), a point every so many metres. */
const TRAIL_M = 25_000;
const TRAIL_STEP_M = 15;
/** The trail is cut where it comes back this near the road ahead: after a U-turn, a camera ahead on the other side
 *  must not be placed on the way already come. */
const TRAIL_CLEAR_M = 60;
/** What is round the car asked again this far on, or this long after; centred this far up the road ahead. */
const NEAR_MOVED_M = 700;
const NEAR_EVERY_MS = 60_000;
const NEAR_AHEAD_M = 700;
/** Features kept for the next line (a 구간 단속's start camera kilometres back among them); the farthest go past this. */
const KEPT_FEATURES = 4000;
/**
 * What was said of a feature is forgotten once the car is this far from it: the same camera passed the other way in the
 * morning was never said on the way home (hantwo's commute replayed, 2026-10-25) — a route's watch is new each drive.
 */
const SPOKEN_FORGET_M = 2000;
/** …or this long after it was first said: the car parked all day by the camera it passed on the way in (hantwo's work). */
const SPOKEN_FORGET_MS = 15 * 60_000;

const turnBetween = (a: number, b: number) => Math.abs(((b - a + 540) % 360) - 180);

export class SafeDrive {
  /** The watch over the road ahead; null while there is none. */
  watch: RouteWatch | null = null;
  line: Line | null = null;
  private seg = 0;
  private trail: LonLat[] = [];
  private trailM = 0;
  /** What was said, by feature id: kept from one line to the next, so a camera is said once. */
  private spoken = new Map<string, Set<number>>();
  /** When each feature was first found said. */
  private spokenSince = new Map<string, number>();
  private known = new Map<string, Feature>();
  private asking = false;
  private askedAt = -Infinity;
  private nearAt: { at: LonLat; t: number } | null = null;
  private nearAsking = false;

  constructor(private deps: SafeDeps) {}

  private now() { return this.deps.now?.() ?? Date.now(); }

  /** Where the car has been: a fix good enough to draw the way back (fed while a route is driven too). */
  trailAt(at: LonLat) {
    const last = this.trail[this.trail.length - 1];
    const d = last ? metres(last[0], last[1], at[0], at[1]) : 0;
    if (last && d < TRAIL_STEP_M) return;
    // A jump (a fix far off, a pretend drive started): the way back is not this one.
    if (d > 2000) { this.trail = []; this.trailM = 0; }
    else this.trailM += d;
    this.trail.push(at);
    while (this.trailM > TRAIL_M && this.trail.length > 2) {
      const [a, b] = this.trail;
      this.trailM -= metres(a[0], a[1], b[0], b[1]);
      this.trail.shift();
    }
  }

  /**
   * The car at [at], heading [deg] at [speedMps]: the road ahead kept up to date. The car's metres along the line, with
   * the watch they are on (a new road ahead may come in before the next update: its metres are another line's), or
   * null while there is no line under it.
   */
  update(at: LonLat, deg: number, speedMps: number): { alongM: number; watch: RouteWatch; line: Line } | null {
    const now = this.now();
    const moving = speedMps >= MOVING_MPS;
    const p = this.line ? this.line.project(at, this.seg, 40) : null;
    const onIt = !!p && p.offM <= OFF_M && (!moving || turnBetween(p.bearing, deg) <= TURNED_DEG);
    const left = p && this.line ? this.line.lengthM - p.alongM : 0;
    if ((!onIt || left < LEFT_M) && moving && !this.asking && now - this.askedAt >= ASK_EVERY_MS) void this.ask(at, deg);
    if (moving) this.askNear(onIt && p ? this.line!.place(p.alongM + NEAR_AHEAD_M).at : at, at, now);
    if (!onIt || !p || !this.watch || !this.line) return null;
    this.seg = p.segment;
    return { alongM: p.alongM, watch: this.watch, line: this.line };
  }

  /** Not in 안전운전 any more (a route set, the mode turned off): the line let go; what was said and seen kept. */
  stop() {
    this.watch = null;
    this.line = null;
    this.seg = 0;
  }

  private async ask(at: LonLat, deg: number) {
    this.asking = true;
    this.askedAt = this.now();
    try {
      const got = await this.deps.ahead(at, deg, AHEAD_M);
      const ahead = got.path;
      if (!ahead || ahead.length < 2) {
        // No road under the car its way (a car park, a lane the map does not have): none ahead until there is.
        this.stop();
        return;
      }
      const behind = this.behind(ahead);
      const path = [...behind, ...ahead];
      const shift = behind.length;
      const route: Route = {
        provider: "osrm", distanceM: 0, durationS: 0, path, guides: [], segments: [],
        motorways: (got.motorways ?? []).map(([a, b]) => [a + shift, b + shift] as [number, number]),
      };
      this.forget(at);
      const watch = new RouteWatch(route, () => this.deps.prefs(), this.spoken);
      watch.add([...this.known.values()]);
      this.watch = watch;
      this.line = new Line(path);
      this.seg = shift;
    } catch (e) {
      this.deps.log(`안전운전 앞길 못 받음 ${(e as Error).message}`);
    } finally {
      this.asking = false;
    }
  }

  /** What was said of the features far from [car] let go: passed long ago, or the far end of a loop. */
  private forget(car: LonLat) {
    const now = this.now();
    for (const id of this.spoken.keys()) {
      const f = this.known.get(id);
      const since = this.spokenSince.get(id) ?? now;
      this.spokenSince.set(id, since);
      if (!f || metres(f.lon, f.lat, car[0], car[1]) > SPOKEN_FORGET_M || now - since > SPOKEN_FORGET_MS) {
        this.spoken.delete(id);
        this.spokenSince.delete(id);
      }
    }
  }

  /** The way the car came, up to where it comes back near the road ahead (after a U-turn, a loop). */
  private behind(ahead: LonLat[]): LonLat[] {
    const far = ahead.filter((p, i) => i > 0 && metres(p[0], p[1], ahead[0][0], ahead[0][1]) > TRAIL_CLEAR_M * 2);
    let from = this.trail.length;
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const t = this.trail[i];
      if (far.some((p) => Math.abs(p[1] - t[1]) < 0.001 && metres(p[0], p[1], t[0], t[1]) < TRAIL_CLEAR_M)) break;
      from = i;
    }
    // The last trail point is about where the road ahead begins: left out, so the line does not step back to it.
    const out = this.trail.slice(from);
    const last = out[out.length - 1];
    if (last && metres(last[0], last[1], ahead[0][0], ahead[0][1]) < TRAIL_STEP_M) out.pop();
    return out;
  }

  private askNear(center: LonLat, car: LonLat, now: number) {
    if (this.nearAsking) return;
    const moved = this.nearAt ? metres(this.nearAt.at[0], this.nearAt.at[1], car[0], car[1]) : Infinity;
    if (this.nearAt && moved < NEAR_MOVED_M && now - this.nearAt.t < NEAR_EVERY_MS) return;
    this.nearAt = { at: car, t: now };
    this.nearAsking = true;
    this.deps.near(center).then((list) => {
      for (const f of list) this.known.set(f.id, f);
      this.trim(car);
      this.watch?.add(list);
    }).catch((e) => {
      this.nearAt = null;
      this.deps.log(`안전운전 시설물 조회 실패 ${(e as Error).message}`);
    }).finally(() => { this.nearAsking = false; });
  }

  private trim(car: LonLat) {
    if (this.known.size <= KEPT_FEATURES) return;
    const far = [...this.known.values()].map((f) => ({ f, d: metres(f.lon, f.lat, car[0], car[1]) })).sort((a, b) => b.d - a.d);
    for (const { f } of far.slice(0, this.known.size - KEPT_FEATURES * 0.8)) this.known.delete(f.id);
  }
}
