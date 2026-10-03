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

  start() {
    if (this.source || typeof EventSource === "undefined" || Date.now() < this.quietUntil) return;
    const es = new EventSource("/api/car/stream");
    this.source = es;
    es.addEventListener("car", (e) => {
      try { this.name = (JSON.parse((e as MessageEvent).data) as { name?: string }).name ?? null; } catch { /* a bad line: ignored */ }
    });
    es.addEventListener("state", (e) => {
      let state = "";
      try { state = (JSON.parse((e as MessageEvent).data) as { state?: string }).state ?? ""; } catch { return; }
      // The account or the way changed on /admin: open again, to the new stream.
      if (state === "reset") { this.restart(2000); return; }
      this.set(state);
    });
    es.onmessage = (e) => {
      let s: CarSample;
      try { s = JSON.parse(e.data) as CarSample; } catch { return; }
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

  private restart(ms: number) {
    this.source?.close();
    this.source = null;
    if (this.retry != null) clearTimeout(this.retry);
    this.retry = window.setTimeout(() => { this.retry = null; this.start(); }, ms);
  }
}
