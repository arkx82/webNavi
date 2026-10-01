/**
 * One moment of the car, as the page's car-track.ts takes it: the car's
 * own time, its speed, its odometer in metres and how fine that odometer
 * is, and where the car itself thinks it is. Whichever stream it came
 * from (the owner streaming or Fleet Telemetry), it leaves here the same.
 */
export interface CarSample {
  /** ms since 1970, the car's clock. */
  t: number;
  /** m/s; null in P. Absent when this sample does not say. */
  speedMps?: number | null;
  odoM?: number | null;
  odoResM?: number | null;
  est?: { lon: number; lat: number; heading: number | null } | null;
}

export const MILE_M = 1609.344;
export const MPH_MPS = MILE_M / 3600;

/**
 * How fine the car's odometer is, read off its own figures: the most
 * decimals seen lately. "12345.6" alone says 0.1 mile; a later "12345.678"
 * says a thousandth. A figure that happens to end in zeros does not make
 * it coarser again, since the most of the last hundred is kept.
 */
export class OdoResolution {
  private decimals: number[] = [];

  /** The raw figure in miles, as text; the resolution in metres so far (null before any). */
  feed(raw: string): number | null {
    const m = raw.trim().match(/^-?\d+(?:\.(\d+))?(?:[eE][-+]?\d+)?$/);
    if (!m) return this.metres();
    // A figure in exponent form (1.2e4) says nothing of its decimals: not counted.
    if (!/[eE]/.test(raw)) {
      this.decimals.push(m[1]?.length ?? 0);
      if (this.decimals.length > 100) this.decimals.shift();
    }
    return this.metres();
  }

  metres(): number | null {
    if (!this.decimals.length) return null;
    return MILE_M * 10 ** -Math.max(...this.decimals);
  }
}
