import { CarTrack, type CarSample } from "./car-track";

/**
 * The car's own samples from the server (/api/car/stream, server car/),
 * into a CarTrack the tracker reads in a tunnel — open only while a route
 * is being driven (the reckoning needs a route), so the car's streaming is
 * asked for no longer than that. EventSource comes back by itself when the
 * link drops; a 204 (no car linked for this user) stops it, and nothing
 * more is asked until the next drive.
 */
export class CarLink {
  readonly track = new CarTrack();
  /** What the server last said of the car's stream: "streaming", "waiting", … — "off" with no car linked. */
  state = "off";
  name: string | null = null;
  samples = 0;
  onState: (state: string) => void = () => {};
  onFirst: (s: CarSample) => void = () => {};
  /** The gear as the car said it, each time it changes (null: left blank). */
  onGear: (gear: CarSample["gear"]) => void = () => {};
  /** Every sample, as it came (the drive's trace). */
  onSample: (s: CarSample) => void = () => {};
  private gear: CarSample["gear"];
  private source: EventSource | null = null;
  private retry: number | null = null;
  /** The car's own time between samples since the last report, ms: how often the stream really sends. */
  private gaps: number[] = [];
  private lastT = 0;
  /** No car for this user (a 204) or refused: not asked again before this, however often start() is called. */
  private quietUntil = 0;
  /** When anything (a sample, a state, a beat) and when a sample last came down the stream, by this page's clock. */
  private heardAt = 0;
  sampleAt = 0;
  private watch: number | null = null;
  /** The stream opened again because it had gone dead or was missing samples: why, for the log. */
  onStall: (why: string) => void = () => {};

  start() {
    if (this.source || typeof EventSource === "undefined" || Date.now() < this.quietUntil) return;
    const es = new EventSource("/api/car/stream");
    this.source = es;
    this.heardAt = Date.now();
    // The server beats every 5 s. Nothing at all for 20 s: the pipe is dead though the browser has not said so.
    if (this.watch == null) this.watch = window.setInterval(() => {
      if (this.source && Date.now() - this.heardAt > 20_000) this.stalled("20초 동안 아무것도 안 옴");
    }, 5_000);
    es.addEventListener("beat", (e) => {
      this.heardAt = Date.now();
      let beat: { state?: string; sampleAgoMs?: number | null };
      try { beat = JSON.parse((e as MessageEvent).data); } catch { return; }
      // The server had a sample in the last 3 s and none reached here for 8: what was sent is stuck on the way —
      // every recovery on 2026-10-09 was a new stream with samples within a tenth of a second.
      if (beat.sampleAgoMs != null && beat.sampleAgoMs < 3000 && Date.now() - this.sampleAt > 8000) {
        this.stalled(`서버는 ${(beat.sampleAgoMs / 1000).toFixed(1)}초 전 샘플, 여기는 ${this.sampleAt ? `${Math.round((Date.now() - this.sampleAt) / 1000)}초` : "아직"} 못 받음`);
      }
    });
    es.addEventListener("car", (e) => {
      try { this.name = (JSON.parse((e as MessageEvent).data) as { name?: string }).name ?? null; } catch { /* a bad line: ignored */ }
    });
    es.addEventListener("state", (e) => {
      let state = "";
      this.heardAt = Date.now();
      try { state = (JSON.parse((e as MessageEvent).data) as { state?: string }).state ?? ""; } catch { return; }
      // The account or the way changed on /admin: open again, to the new stream.
      if (state === "reset") { this.restart(2000); return; }
      this.set(state);
    });
    es.onmessage = (e) => {
      let s: CarSample;
      try { s = JSON.parse(e.data) as CarSample; } catch { return; }
      this.heardAt = this.sampleAt = Date.now();
      if (!this.samples++) this.onFirst(s);
      if (this.lastT && s.t > this.lastT) this.gaps.push(s.t - this.lastT);
      this.lastT = Math.max(this.lastT, s.t);
      this.track.add(s);
      this.onSample(s);
      if (s.gear !== undefined && s.gear !== this.gear) { this.gear = s.gear; this.onGear(s.gear); }
    };
    es.onerror = () => {
      // Closed for good (a 204, or refused): no car for this user.
      if (es.readyState === EventSource.CLOSED) { this.source = null; this.quietUntil = Date.now() + 10 * 60_000; this.set("off"); }
      else this.set("reconnecting");
    };
  }

  /** The drive over: the stream let go (the server stops asking Tesla a minute later). */
  stop() {
    if (this.retry != null) clearTimeout(this.retry);
    this.retry = null;
    if (this.watch != null) clearInterval(this.watch);
    this.watch = null;
    this.source?.close();
    this.source = null;
    this.set("off");
  }

  /** How often samples came since the last call, by the car's clock: the median and the longest gap, ms. */
  intervals(): { n: number; medianMs: number; maxMs: number } | null {
    const g = this.gaps.sort((a, b) => a - b);
    this.gaps = [];
    if (!g.length) return null;
    return { n: g.length + 1, medianMs: g[g.length >> 1], maxMs: g[g.length - 1] };
  }

  private set(state: string) {
    if (state === this.state) return;
    this.state = state;
    this.onState(state);
  }

  /** Samples this old are no help: the stream is "streaming" in name only. */
  stale(ms = 10_000): boolean {
    return this.state === "streaming" && Date.now() - this.sampleAt > ms;
  }

  private stalled(why: string) {
    this.onStall(why);
    this.set("reconnecting");
    this.restart(0);
  }

  private restart(ms: number) {
    this.source?.close();
    this.source = null;
    if (this.retry != null) clearTimeout(this.retry);
    this.retry = window.setTimeout(() => { this.retry = null; this.start(); }, ms);
  }
}
