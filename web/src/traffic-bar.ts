import type { Line } from "./geo";
import { COLOURS } from "./route-layer";
import type { Route } from "./types";

/**
 * 경로 막힘 막대: the whole route as a thin bar up the map's right edge, the start at its foot and the destination at
 * its top, in the route line's traffic colours — where it is slow or stands ahead seen at once, beyond the stretch the
 * map shows (NAVER's cluster screen draws one, 2026-10-15). The part driven is greyed and the car is a dot on it.
 */

/** The bar's colours from its foot (0 %) to its top (100 %), as CSS gradient stops; runs of one colour merged. */
export function trafficStops(route: Pick<Route, "segments" | "path">, along: ArrayLike<number>): string {
  const n = route.path.length;
  const total = n ? along[n - 1] : 0;
  if (!(total > 0)) return `${COLOURS[0]} 0%, ${COLOURS[0]} 100%`;
  const pct = (i: number) => (100 * along[Math.max(0, Math.min(n - 1, i))]) / total;
  // The segments in order, the stretches between them unknown (the plain route blue).
  const runs: { from: number; to: number; colour: string }[] = [];
  let at = 0;
  for (const s of [...route.segments].sort((a, b) => a.from - b.from)) {
    if (s.to <= at) continue;
    if (s.from > at) runs.push({ from: at, to: s.from, colour: COLOURS[0] });
    runs.push({ from: Math.max(at, s.from), to: s.to, colour: COLOURS[s.congestion] ?? COLOURS[0] });
    at = s.to;
  }
  if (at < n - 1) runs.push({ from: at, to: n - 1, colour: COLOURS[0] });
  const merged: typeof runs = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.colour === r.colour) last.to = r.to;
    else merged.push({ ...r });
  }
  return merged.map((r) => `${r.colour} ${pct(r.from).toFixed(2)}%, ${r.colour} ${pct(r.to).toFixed(2)}%`).join(", ");
}

/** A fingerprint of the route's traffic: traffic.ts repaints the segments in place every six minutes. */
function trafficKey(route: Route): string {
  let h = route.segments.length;
  for (const s of route.segments) h = (h * 31 + s.from * 7 + s.to * 3 + s.congestion) % 2_147_483_647;
  return `${route.path.length}:${h}`;
}

export class TrafficBar {
  private route: Route | null = null;
  private key = "";
  private shownPct = -1;

  constructor(private el: HTMLElement) {
    el.innerHTML = `<div class="tb-done"></div><div class="tb-car"></div>`;
  }

  /** The bar for [route] with the car [alongM] along [line]; hidden without a route, or where its provider gave no traffic. */
  show(route: Route | null, line: Line | null, alongM: number | null, on: boolean) {
    const want = on && !!route && !!line && route.segments.some((s) => s.congestion > 0);
    if (!want) {
      if (!this.el.hidden) { this.el.hidden = true; document.body.classList.remove("traffic-bar"); }
      this.route = null;
      return;
    }
    // The buttons and the music player at the right edge step in for it (style.css body.traffic-bar).
    if (this.el.hidden) { this.el.hidden = false; document.body.classList.add("traffic-bar"); }
    const key = trafficKey(route!);
    if (route !== this.route || key !== this.key) {
      this.route = route;
      this.key = key;
      this.el.style.background = `linear-gradient(to top, ${trafficStops(route!, line!.along)})`;
    }
    const pct = Math.round((1000 * Math.max(0, Math.min(1, (alongM ?? 0) / Math.max(1, line!.lengthM))))) / 10;
    if (pct !== this.shownPct) {
      this.shownPct = pct;
      this.el.style.setProperty("--tb-at", `${pct}%`);
    }
  }
}
