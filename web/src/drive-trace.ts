import type { CarSample } from "./car-track";
import type { Fix } from "./gps";
import type { Shown } from "./tracker";
import type { Route } from "./types";

/**
 * The drive as it happened, a line a moment, for the server to keep beside
 * the 진단 log (…-YYYY-MM-DD.trace): every fix as the browser gave it, every
 * sample of the car's own, the marker as it was drawn a second at a time,
 * and each route as it was given. A drive on the road can then be played
 * again at a desk through the same tracker (tools/replay-trace.ts): what the
 * car's browser does (fixes 1 to 30 s apart, a route changed between two of
 * them, a car that goes another way than the route) the pretend drive only
 * imitates.
 *
 * f,received,t,lon,lat,accM,speed,course
 * c,received,t,speed,odoM,odoResM,estLon,estLat,estHeading,gear,soc,powerKw   (blank: not said; "-": said as none)
 * s,received,lon,lat,mode,alongM,offRoute
 * r,received,{provider,durationS,path,guides,segments,motorways}
 */
export class DriveTrace {
  private rows: string[] = [];
  /** Lines held at most, if the server cannot be reached for a long while: the oldest are let go. */
  private static readonly KEPT = 20_000;

  fix(f: Fix) {
    this.push(`f,${Date.now()},${f.t},${f.lon.toFixed(6)},${f.lat.toFixed(6)},${num(f.accM, 1)},${num(f.speed, 2)},${num(f.course, 1)}`);
  }

  car(s: CarSample) {
    const said = <T,>(v: T | null | undefined, put: (v: T) => string) => (v === undefined ? "" : v === null ? "-" : put(v));
    const est = s.est;
    this.push([
      "c", Date.now(), s.t,
      said(s.speedMps, (v) => v.toFixed(2)), said(s.odoM, (v) => v.toFixed(1)), said(s.odoResM, (v) => String(v)),
      est ? est.lon.toFixed(6) : said(est, () => ""), est ? est.lat.toFixed(6) : "", est?.heading != null ? est.heading.toFixed(1) : "",
      said(s.gear, (v) => v), said(s.soc, (v) => String(v)), said(s.powerKw, (v) => String(v)),
    ].join(","));
  }

  shown(s: Shown) {
    this.push(`s,${Date.now()},${s.at[0].toFixed(6)},${s.at[1].toFixed(6)},${s.mode},${s.alongM != null ? s.alongM.toFixed(1) : ""},${s.offRoute ? 1 : 0}`);
  }

  route(r: Route) {
    const pair = ([x, y]: [number, number]) => [Number(x.toFixed(6)), Number(y.toFixed(6))];
    this.push(`r,${Date.now()},${JSON.stringify({
      provider: r.provider, durationS: r.durationS, distanceM: r.distanceM, path: r.path.map(pair),
      guides: r.guides.map((g) => ({ at: pair(g.at), text: g.text, turnType: g.turnType })), segments: r.segments, motorways: r.motorways,
    })}`);
  }

  /** The lines not yet sent, handed over. */
  take(): string[] {
    return this.rows.splice(0, this.rows.length);
  }

  private push(line: string) {
    this.rows.push(line);
    if (this.rows.length > DriveTrace.KEPT) this.rows.splice(0, this.rows.length - DriveTrace.KEPT);
  }
}

const num = (v: number | null | undefined, digits: number) => (v == null || !Number.isFinite(v) ? "" : v.toFixed(digits));
