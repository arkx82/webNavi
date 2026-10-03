import { CarTrack, type CarSample } from "./car-track";
import { metres } from "./geo";
import type { Fix } from "./gps";
import { Tracker } from "./tracker";
import type { LonLat, Route } from "./types";

/**
 * A drive's trace (drive-trace.ts) played again through the tracker, on the
 * trace's own clock: the fixes as they came, the car's samples, the routes
 * as they were set — and what went wrong, said: the marker far from a good
 * fix when it came, the marker leaping, the reckoning's misses, the drive
 * called off the route. Where the trace has the marker as it was drawn on
 * the road, that is set beside the one drawn now (the code since changed).
 */
export interface ReplayEvent {
  /** ms, the trace's clock (Date.now on the car). */
  t: number;
  kind: "far" | "leap" | "reckon" | "off" | "route";
  text: string;
  at?: LonLat;
}

export interface ReplayReport {
  events: ReplayEvent[];
  fixes: number;
  /** The gaps between fixes, s: how the car's browser spaced them. */
  gaps: { median: number; p90: number; max: number };
  /** The marker drawn now against the one drawn on the road, where the trace has it: metres, the median and the most. */
  againstRoad: { median: number; max: number } | null;
  /** The battery over the drive, as the car said it: % at the first and last sample, and the odometer's km between. */
  battery: { from: number; to: number; km: number } | null;
}

/** A good fix this far from where the marker was is told. */
export const FAR_M = 50;
/** A frame-to-frame move this long (in a tenth of a second) is a leap. */
export const LEAP_M = 60;
const STEP_MS = 100;

type Row =
  | { kind: "f"; at: number; fix: Fix }
  | { kind: "c"; at: number; sample: CarSample }
  | { kind: "s"; at: number; shown: LonLat }
  | { kind: "r"; at: number; route: Route };

/** The trace's lines as rows, in the order they came. */
export function parseTrace(text: string): Row[] {
  const rows: Row[] = [];
  const n = (v: string | undefined) => (v == null || v === "" || v === "-" ? null : Number(v));
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const kind = line[0];
    if (kind === "r") {
      const comma = line.indexOf(",", 2);
      try {
        rows.push({ kind: "r", at: Number(line.slice(2, comma)), route: JSON.parse(line.slice(comma + 1)) as Route });
      } catch { /* a cut line */ }
      continue;
    }
    const c = line.split(",");
    const at = Number(c[1]);
    if (!Number.isFinite(at)) continue;
    if (kind === "f") {
      rows.push({ kind: "f", at, fix: { t: Number(c[2]), lon: Number(c[3]), lat: Number(c[4]), accM: n(c[5]) ?? 9999, speed: n(c[6]), heading: n(c[7]), course: n(c[7]) } });
    } else if (kind === "c") {
      const said = <T,>(v: string | undefined, read: (v: string) => T): T | null | undefined => (v == null || v === "" ? undefined : v === "-" ? null : read(v));
      const sample: CarSample = { t: Number(c[2]) };
      const soc = said(c[10], Number), power = said(c[11], Number);
      if (soc !== undefined) sample.soc = soc;
      if (power !== undefined) sample.powerKw = power;
      const speed = said(c[3], Number), odo = said(c[4], Number), res = said(c[5], Number), gear = said(c[9], (v) => v as NonNullable<CarSample["gear"]>);
      if (speed !== undefined) sample.speedMps = speed;
      if (odo !== undefined) sample.odoM = odo;
      if (res !== undefined) sample.odoResM = res;
      if (c[6] === "-") sample.est = null;
      else if (c[6]) sample.est = { lon: Number(c[6]), lat: Number(c[7]), heading: n(c[8]) };
      if (gear !== undefined) sample.gear = gear;
      rows.push({ kind: "c", at, sample });
    } else if (kind === "s") {
      rows.push({ kind: "s", at, shown: [Number(c[2]), Number(c[3])] });
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

export function replayTrace(rows: Row[]): ReplayReport {
  const tracker = new Tracker();
  const car = new CarTrack();
  tracker.car = car;
  const events: ReplayEvent[] = [];
  const hhmmss = (t: number) => new Date(t + 9 * 3600_000).toISOString().slice(11, 19);
  tracker.onOffRoute = (at) => events.push({ t: clock, kind: "off", text: `${hhmmss(clock)} 경로 이탈`, at });
  tracker.onReckonEnd = (r) => {
    if (r.errorM != null && Math.abs(r.errorM) > FAR_M) events.push({ t: clock, kind: "reckon", text: `${hhmmss(clock)} 추측 항법 ${Math.round(r.seconds)}초 끝 · ${r.free ? "경로 밖" : "경로 위"} · ${Math.round(r.errorM)} m 빗나감` });
  };
  let clock = rows[0]?.at ?? 0;
  let last: LonLat | null = null;
  let fixes = 0;
  const gaps: number[] = [];
  let lastFixAt = 0;
  const against: number[] = [];
  let socFrom: number | null = null, socTo: number | null = null, odoFrom: number | null = null, odoTo: number | null = null;
  const step = (until: number) => {
    while (clock + STEP_MS <= until) {
      clock += STEP_MS;
      const shown = tracker.frame(clock);
      if (!shown) continue;
      if (last && metres(last[0], last[1], shown.at[0], shown.at[1]) > LEAP_M) {
        events.push({ t: clock, kind: "leap", text: `${hhmmss(clock)} 표시가 ${Math.round(metres(last[0], last[1], shown.at[0], shown.at[1]))} m 튐 (${shown.mode})`, at: shown.at });
      }
      last = shown.at;
    }
  };
  for (const row of rows) {
    step(row.at);
    clock = Math.max(clock, row.at);
    if (row.kind === "c") {
      car.add(row.sample, row.at);
      if (row.sample.soc != null) { socFrom ??= row.sample.soc; socTo = row.sample.soc; }
      if (row.sample.odoM != null) { odoFrom ??= row.sample.odoM; odoTo = row.sample.odoM; }
    }
    else if (row.kind === "r") {
      tracker.setRoute(row.route);
      events.push({ t: row.at, kind: "route", text: `${hhmmss(row.at)} 경로 ${row.route.provider} ${(row.route.distanceM / 1000).toFixed(1)} km` });
    } else if (row.kind === "s") {
      const now = tracker.frame(clock);
      if (now) against.push(metres(now.at[0], now.at[1], row.shown[0], row.shown[1]));
    } else {
      fixes++;
      if (lastFixAt) gaps.push((row.at - lastFixAt) / 1000);
      lastFixAt = row.at;
      const before = tracker.frame(clock);
      if (before && row.fix.accM <= 30) {
        const off = metres(before.at[0], before.at[1], row.fix.lon, row.fix.lat);
        if (off > FAR_M) events.push({ t: row.at, kind: "far", text: `${hhmmss(row.at)} 표시가 GPS와 ${Math.round(off)} m (${before.mode}${before.offRoute ? ", 경로 밖" : ""})`, at: [row.fix.lon, row.fix.lat] });
      }
      tracker.feed(row.fix, clock);
      last = tracker.frame(clock)?.at ?? last;
    }
  }
  const sorted = (v: number[]) => [...v].sort((a, b) => a - b);
  const g = sorted(gaps), a = sorted(against);
  return {
    events,
    fixes,
    gaps: { median: g[g.length >> 1] ?? 0, p90: g[Math.floor(g.length * 0.9)] ?? 0, max: g[g.length - 1] ?? 0 },
    againstRoad: a.length ? { median: a[a.length >> 1], max: a[a.length - 1] } : null,
    battery: socFrom != null && socTo != null ? { from: socFrom, to: socTo, km: odoFrom != null && odoTo != null ? (odoTo - odoFrom) / 1000 : 0 } : null,
  };
}
