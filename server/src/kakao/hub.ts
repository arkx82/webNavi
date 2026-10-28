/**
 * 카카오 안전운전 (kakao-safety/README.md): a few emulators each run 카카오내비 SDK's 안전운전 for one car. Here the cars
 * are given a slot (first come, while one is free), their fixes handed to their slot's app, and what the SDK would
 * say of a camera handed back to the car — to be said there if our own lists have not said it. While the car has a
 * route, its slot also asks 카카오 for that route once and hands back where a 노면색깔유도선 is painted on its way.
 *
 * Nothing of 카카오's is kept past its use: an event waits for its car a few seconds, then is dropped.
 */

/** Our kinds for 카카오's safety codes; the rest (bumps, fog, accident spots …) are not ours to say. */
const KINDS: [RegExp, string][] = [
  [/^KNSafetyCode_SpeedViolationSection(In|InOnly)(Backward)?Camera$/, "section-start"],
  [/^KNSafetyCode_SpeedViolationSection(Out|OutOnly)(Backward)?Camera$/, "section-end"],
  [/^KNSafetyCode_SignalAndSpeedViolation(Backward)?Camera$/, "speed-signal"],
  [/^KNSafetyCode_SignalViolationCamera$/, "signal"],
  [/^KNSafetyCode_(SpeedViolation(Backward)?|BoxedSpeedViolation|MovableSpeedViolation|LaneAndSpeedViolation|BuslaneAndSpeedViolation)Camera$/, "speed"],
  [/^KNSafetyCode_ChildrenProtectionZone$/, "school-zone"],
];
export function kindOf(code: string): string | null {
  for (const [re, kind] of KINDS) if (re.test(code)) return kind;
  return null;
}

export interface KakaoSafety { id: number; kind: string; code: string; lon: number; lat: number; limit?: number; dist: number; road?: string }
export interface Fix { lon: number; lat: number; speed?: number | null; bearing?: number | null; acc?: number | null }
/** Our names for 카카오's 노면색깔유도선 colours (KNRGLaneColor). */
export type LineColour = "pink" | "green" | "lightgreen" | "sky";
const COLOURS: Record<string, LineColour> = { KNRGLaneColor_Pink: "pink", KNRGLaneColor_Green: "green", KNRGLaneColor_LightGreen: "lightgreen", KNRGLaneColor_SkyBlue: "sky" };
/** A guidance point on 카카오's way for the car's route where a coloured line is painted to follow. */
export interface KakaoLine { lon: number; lat: number; colour: LineColour; rg: string; name?: string }
/** The car's route, as asked of its slot: an id of the page's (a new route, a new id), from where the car was, to its goal. */
export interface Trip { id: string; start: [number, number]; goal: [number, number] }
/** 카카오's answer for a trip: its lines, how many guidance points it had, or why none. */
export interface TripLines { id: string; lines: KakaoLine[]; total: number; error?: string }

/** A car's fixes stop this long and its slot is let go. */
export const SLOT_IDLE_MS = 90_000;
/** An event waits this long for its car's next ask. */
const EVENT_KEEP_MS = 15_000;
/** The app has asked within this: it is up. */
const APP_SEEN_MS = 30_000;

interface Slot {
  n: number;
  user: string | null;
  lastFixAt: number;
  fix: (Fix & { seq: number; t: number }) | null;
  seq: number;
  waiters: (() => void)[];
  events: { t: number; safety: KakaoSafety }[];
  appSeenAt: number;
  state: string;
  detail: string;
  said: number;
  /** The car's route, until its lines come back; then those, until the car has them. */
  trip: Trip | null;
  lines: TripLines | null;
}

export class KakaoHub {
  private slots: Slot[];
  constructor(count: number, private appKey: () => string | undefined, private now: () => number = Date.now, private log: (m: string) => void = () => {}) {
    // The fixes' seq from the clock, not from 0: the app and the feeder keep the last seq they saw across a restart of
    // nav (a deploy mid-drive), and from 0 again they would wait out as many fixes as the drive had had.
    this.slots = Array.from({ length: Math.max(0, count) }, (_, i) => ({
      n: i + 1, user: null, lastFixAt: 0, fix: null, seq: this.now(), waiters: [], events: [], appSeenAt: 0, state: "down", detail: "", said: 0, trip: null, lines: null,
    }));
  }

  get size() { return this.slots.length; }
  /** On for the cars: slots, a key, and at least one app up and ready. */
  get ready() { return !!this.appKey() && this.slots.some((s) => this.serving(s)); }
  private appUp(s: Slot) { return this.now() - s.appSeenAt < APP_SEEN_MS; }
  /** Up, and through the SDK's initialisation: one stuck "pending" or refused would take a car and give it nothing. */
  private serving(s: Slot) { return this.appUp(s) && (s.state === "ready" || s.state === "guiding"); }

  private release(s: Slot, why: string) {
    if (s.user) this.log(`kakao slot ${s.n}: ${s.user} let go (${why})`);
    s.user = null; s.fix = null; s.events = []; s.trip = null; s.lines = null;
    for (const w of s.waiters.splice(0)) w();
  }
  private sweep() {
    for (const s of this.slots) if (s.user && this.now() - s.lastFixAt > SLOT_IDLE_MS) this.release(s, "no fixes");
  }

  /**
   * A car's fix: onto its slot (a free one given if it has none), and what 카카오 has said for it since, and the cameras
   * it has ahead. No slot free (or none up): nothing, and the car goes on with our own lists alone.
   */
  carFix(user: string, fix: Fix, trip?: { id: string; goal: [number, number]; have?: boolean }): { slot: number | null; events: KakaoSafety[]; lines?: TripLines; why?: string } {
    this.sweep();
    let s = this.slots.find((x) => x.user === user);
    if (!s) {
      s = this.slots.find((x) => !x.user && this.serving(x));
      if (!s) return { slot: null, events: [], why: this.slots.some((x) => this.serving(x)) ? "busy" : "down" };
      s.user = user;
      s.said = 0;
      this.log(`kakao slot ${s.n}: ${user}`);
    }
    s.lastFixAt = this.now();
    s.seq++;
    s.fix = { ...fix, seq: s.seq, t: this.now() };
    // A route not asked yet: asked from where the car is now. One the car already has the lines of (a page reloaded
    // with its drive) is not asked again.
    if (trip && trip.id !== s.trip?.id && !trip.have) {
      s.trip = { id: trip.id, start: [fix.lon, fix.lat], goal: trip.goal };
      s.lines = null;
    }
    if (!trip) { s.trip = null; s.lines = null; }
    for (const w of s.waiters.splice(0)) w();
    const fresh = s.events.filter((e) => this.now() - e.t < EVENT_KEEP_MS).map((e) => e.safety);
    s.events = [];
    const lines = s.lines && s.lines.id === trip?.id && !trip.have ? s.lines : undefined;
    return { slot: s.n, events: fresh, ...(lines ? { lines } : {}) };
  }

  /** The car's drive is over (its page let go, a route ended at home …): its slot freed at once. */
  carDone(user: string) {
    const s = this.slots.find((x) => x.user === user);
    if (s) this.release(s, "done");
  }

  /** The app's long ask: its car's next fix (after [after]), whether a car is on it, and the key. */
  async appAsk(n: number, after: number, waitMs: number, feeder = false): Promise<{ active: boolean; appKey: string; fix: Slot["fix"]; trip?: Trip } | null> {
    const s = this.slots[n - 1];
    if (!s) return null;
    // The container's GPS feeder asks too (feeder.py): only the app's own asks say the app is up.
    if (!feeder) s.appSeenAt = this.now();
    if (!feeder && s.state === "down") s.state = "up";
    this.sweep();
    if (!(s.fix && s.fix.seq > after) && waitMs > 0) {
      await new Promise<void>((done) => {
        const t = setTimeout(() => { s.waiters = s.waiters.filter((w) => w !== wake); done(); }, waitMs);
        const wake = () => { clearTimeout(t); done(); };
        s.waiters.push(wake);
      });
    }
    if (!feeder) s.appSeenAt = this.now();
    const trip = !feeder && s.trip && s.lines?.id !== s.trip.id ? s.trip : undefined;
    return { active: !!s.user, appKey: feeder ? "" : this.appKey() ?? "", fix: s.fix && s.fix.seq > after ? s.fix : null, ...(trip ? { trip } : {}) };
  }

  /** What the app tells: its state, or a warning the SDK would say now. */
  appEvent(n: number, e: { kind?: string; state?: string; detail?: string; safety?: Raw; voiceCode?: string; id?: unknown; lines?: unknown; total?: unknown; error?: unknown }): boolean {
    const s = this.slots[n - 1];
    if (!s) return false;
    s.appSeenAt = this.now();
    if (e.kind === "status") {
      if (e.state && e.state !== s.state) this.log(`kakao slot ${s.n}: ${e.state} ${e.detail ?? ""}`);
      s.state = String(e.state ?? s.state);
      // Shown on /admin: cut short, and only what reads as text (the SDK's error message, the app's own words).
      s.detail = String(e.detail ?? "").replace(/[<>&]/g, " ").slice(0, 200);
    } else if (e.kind === "voice" && s.user && e.safety) {
      const safety = parse(e.safety);
      if (safety) { s.events.push({ t: this.now(), safety }); s.said++; }
    } else if (e.kind === "lines" && s.trip && String(e.id ?? "") === s.trip.id) {
      const lines = (Array.isArray(e.lines) ? e.lines : []).map((r) => parseLine(r as RawLine)).filter((l): l is KakaoLine => !!l);
      s.lines = { id: s.trip.id, lines, total: Number(e.total) || 0, ...(e.error ? { error: String(e.error).replace(/[<>&]/g, " ").slice(0, 200) } : {}) };
      this.log(`kakao slot ${s.n}: 유도선 ${lines.length}곳 / 안내 지점 ${s.lines.total}${s.lines.error ? ` (${s.lines.error})` : ""}`);
    }
    return true;
  }

  /** /admin's line: each slot, up or not, whose car, what it said. */
  status(): string {
    if (!this.slots.length) return "꺼짐 (KAKAO_SLOTS 없음)";
    if (!this.appKey()) return `슬롯 ${this.slots.length}개 · 카카오 네이티브 앱 키 없음`;
    return this.slots.map((s) => `${s.n}: ${!this.appUp(s) ? "앱 연결 안 됨" : s.state === "error" ? `오류 ${s.detail}` : s.user ? `${s.user} 주행 중 · 카카오 안내 ${s.said}회` : s.state === "ready" || s.state === "guiding" ? "대기" : s.detail || s.state}`).join("\n");
  }
}

type RawLine = { lon?: unknown; lat?: unknown; color?: unknown; rg?: unknown; name?: unknown };
function parseLine(r: RawLine): KakaoLine | null {
  const colour = COLOURS[String(r?.color ?? "")];
  const lon = Number(r?.lon), lat = Number(r?.lat);
  if (!colour || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  return { lon, lat, colour, rg: String(r.rg ?? "").replace(/^KNRGCode_/, "").slice(0, 40), ...(r.name ? { name: String(r.name).slice(0, 60) } : {}) };
}

type Raw = { id?: unknown; code?: unknown; lon?: unknown; lat?: unknown; limit?: unknown; dist?: unknown; road?: unknown };
function parse(r: Raw): KakaoSafety | null {
  const code = String(r.code ?? "");
  const kind = kindOf(code);
  const lon = Number(r.lon), lat = Number(r.lat);
  if (!kind || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  const limit = Number(r.limit);
  return { id: Number(r.id) || 0, kind, code, lon, lat, ...(limit >= 10 && limit <= 130 ? { limit } : {}), dist: Number(r.dist) || -1, ...(r.road ? { road: String(r.road) } : {}) };
}
