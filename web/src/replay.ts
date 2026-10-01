import type { Fix, Gps } from "./gps";

/**
 * A drive played back from a saved log, at its own pace or faster, into
 * the same listeners the car's fixes reach — so the matching, the guides
 * and the warnings can be worked on at a desk. teslanav.com does this with
 * GPX; ours is the CSV the 로그 저장 button writes.
 */
export class Replay {
  private timer: number | null = null;
  private i = 0;

  constructor(private gps: Gps, private fixes: Fix[], private speedup = 1) {}

  static fromCsv(text: string): Fix[] {
    const [head, ...rows] = text.trim().split(/\r?\n/);
    const col = head.split(",");
    const at = (row: string[], name: string) => row[col.indexOf(name)];
    const num = (v: string | undefined) => (v == null || v === "" ? null : Number(v));
    return rows.map((line) => {
      const row = line.split(",");
      return {
        t: Number(at(row, "t")),
        lon: Number(at(row, "lon")),
        lat: Number(at(row, "lat")),
        accM: Number(at(row, "accM")),
        speed: num(at(row, "speed")),
        heading: num(at(row, "heading")),
        course: num(at(row, "course")),
      };
    // Without a time a fix cannot be spaced: NaN would make every wait zero and the whole log play at once.
    }).filter((f) => Number.isFinite(f.t) && Number.isFinite(f.lon) && Number.isFinite(f.lat));
  }

  start() {
    this.gps.stop();
    this.i = 0;
    this.step();
  }

  stop() {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
  }

  get playing() {
    return this.timer != null;
  }

  private step() {
    if (this.i >= this.fixes.length) {
      this.timer = null;
      return;
    }
    const fix = this.fixes[this.i++];
    // Re-stamped to now so the period and the dead reckoning see real time.
    this.gps.feed({ ...fix, t: Date.now(), course: null });
    const next = this.fixes[this.i];
    const wait = next ? Math.min(5000, Math.max(50, (next.t - fix.t) / this.speedup)) : 0;
    this.timer = window.setTimeout(() => this.step(), wait);
  }
}
