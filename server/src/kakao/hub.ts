/**
 * 카카오 안전운전 (kakao-safety/README.md): a few emulators each run 카카오내비 SDK's 안전운전 for one car. Here the cars
 * are given a slot (first come, while one is free), their fixes handed to their slot's app, and what the SDK would
 * say of a camera handed back to the car — to be said there if our own lists have not said it.
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
  ahead: KakaoSafety[];
  aheadAt: number;
  appSeenAt: number;
  state: string;
  detail: string;
  said: number;
}

export class KakaoHub {
  private slots: Slot[];
  constructor(count: number, private appKey: () => string | undefined, private now: () => number = Date.now, private log: (m: string) => void = () => {}) {
    this.slots = Array.from({ length: Math.max(0, count) }, (_, i) => ({
      n: i + 1, user: null, lastFixAt: 0, fix: null, seq: 0, waiters: [], events: [], ahead: [], aheadAt: 0, appSeenAt: 0, state: "down", detail: "", said: 0,
    }));
  }

  get size() { return this.slots.length; }
  /** On for the cars: slots, a key, and at least one app up and ready. */
  get ready() { return !!this.appKey() && this.slots.some((s) => this.appUp(s) && (s.state === "ready" || s.state === "guiding")); }
  private appUp(s: Slot) { return this.now() - s.appSeenAt < APP_SEEN_MS; }

  private release(s: Slot, why: string) {
    if (s.user) this.log(`kakao slot ${s.n}: ${s.user} let go (${why})`);
    s.user = null; s.fix = null; s.events = []; s.ahead = [];
    for (const w of s.waiters.splice(0)) w();
  }
  private sweep() {
    for (const s of this.slots) if (s.user && this.now() - s.lastFixAt > SLOT_IDLE_MS) this.release(s, "no fixes");
  }

  /**
   * A car's fix: onto its slot (a free one given if it has none), and what 카카오 has said for it since, and the cameras
   * it has ahead. No slot free (or none up): nothing, and the car goes on with our own lists alone.
   */
  carFix(user: string, fix: Fix): { slot: number | null; events: KakaoSafety[]; ahead: KakaoSafety[]; why?: string } {
    this.sweep();
    let s = this.slots.find((x) => x.user === user);
    if (!s) {
      s = this.slots.find((x) => !x.user && this.appUp(x) && x.state !== "error");
      if (!s) return { slot: null, events: [], ahead: [], why: this.slots.some((x) => this.appUp(x)) ? "busy" : "down" };
      s.user = user;
      s.said = 0;
      this.log(`kakao slot ${s.n}: ${user}`);
    }
    s.lastFixAt = this.now();
    s.seq++;
    s.fix = { ...fix, seq: s.seq, t: this.now() };
    for (const w of s.waiters.splice(0)) w();
    const fresh = s.events.filter((e) => this.now() - e.t < EVENT_KEEP_MS).map((e) => e.safety);
    s.events = [];
    return { slot: s.n, events: fresh, ahead: this.now() - s.aheadAt < 5000 ? s.ahead : [] };
  }

  /** The car's drive is over (its page let go, a route ended at home …): its slot freed at once. */
  carDone(user: string) {
    const s = this.slots.find((x) => x.user === user);
    if (s) this.release(s, "done");
  }

  /** The app's long ask: its car's next fix (after [after]), whether a car is on it, and the key. */
  async appAsk(n: number, after: number, waitMs: number): Promise<{ active: boolean; appKey: string; fix: Slot["fix"] } | null> {
    const s = this.slots[n - 1];
    if (!s) return null;
    s.appSeenAt = this.now();
    if (s.state === "down") s.state = "up";
    this.sweep();
    if (!(s.fix && s.fix.seq > after) && waitMs > 0) {
      await new Promise<void>((done) => {
        const t = setTimeout(() => { s.waiters = s.waiters.filter((w) => w !== wake); done(); }, waitMs);
        const wake = () => { clearTimeout(t); done(); };
        s.waiters.push(wake);
      });
    }
    s.appSeenAt = this.now();
    return { active: !!s.user, appKey: this.appKey() ?? "", fix: s.fix && s.fix.seq > after ? s.fix : null };
  }

  /** What the app tells: its state, a warning the SDK would say now, the cameras it has ahead. */
  appEvent(n: number, e: { kind?: string; state?: string; detail?: string; safety?: Raw; safeties?: Raw[]; voiceCode?: string }): boolean {
    const s = this.slots[n - 1];
    if (!s) return false;
    s.appSeenAt = this.now();
    if (e.kind === "status") {
      if (e.state && e.state !== s.state) this.log(`kakao slot ${s.n}: ${e.state} ${e.detail ?? ""}`);
      s.state = String(e.state ?? s.state);
      s.detail = String(e.detail ?? "");
    } else if (e.kind === "voice" && s.user && e.safety) {
      const safety = parse(e.safety);
      if (safety) { s.events.push({ t: this.now(), safety }); s.said++; }
    } else if (e.kind === "ahead" && s.user) {
      s.ahead = (e.safeties ?? []).map(parse).filter((x): x is KakaoSafety => !!x).sort((a, b) => a.dist - b.dist).slice(0, 8);
      s.aheadAt = this.now();
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

type Raw = { id?: unknown; code?: unknown; lon?: unknown; lat?: unknown; limit?: unknown; dist?: unknown; road?: unknown };
function parse(r: Raw): KakaoSafety | null {
  const code = String(r.code ?? "");
  const kind = kindOf(code);
  const lon = Number(r.lon), lat = Number(r.lat);
  if (!kind || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  const limit = Number(r.limit);
  return { id: Number(r.id) || 0, kind, code, lon, lat, ...(limit >= 10 && limit <= 130 ? { limit } : {}), dist: Number(r.dist) || -1, ...(r.road ? { road: String(r.road) } : {}) };
}
