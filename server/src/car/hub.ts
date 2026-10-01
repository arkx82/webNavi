import type { CarSample } from "./sample.js";

/** A car linked on /admin: its VIN, the owner API's ids, and which of this site's users sees it (empty: everyone). */
export interface LinkedCar {
  vin: string;
  id: string;
  vehicleId: number;
  name: string;
  user: string;
}

/** Where a car's samples come from: started when someone listens, stopped a while after the last leaves. */
export interface CarSource {
  start(): void;
  stop(): void;
  readonly state: string;
  readonly lastError: string | null;
  readonly lastSampleAt: number;
}

export interface CarListener {
  sample(s: CarSample): void;
  state(state: string): void;
}

/** Kept open this long after the last page goes (a reload, a tunnel's own dropout): not torn down and set up again. */
const LINGER_MS = 60_000;

/**
 * The car pages listening, by VIN, and the one stream each car needs:
 * nothing is asked of Tesla while no page is open, so a parked car is
 * left asleep and no streaming signal is spent on it.
 */
export class CarHub {
  private listeners = new Map<string, Set<CarListener>>();
  private sources = new Map<string, CarSource>();
  private linger = new Map<string, NodeJS.Timeout>();

  constructor(
    private cars: () => LinkedCar[],
    private make: (car: LinkedCar, emit: (s: CarSample) => void, state: (st: string) => void) => CarSource | null,
  ) {}

  /** The cars [user] sees. */
  carsFor(user: string): LinkedCar[] {
    return this.cars().filter((c) => !c.user || c.user.toLowerCase() === user.toLowerCase());
  }

  /** [l] hears [vin]'s samples until the returned call. */
  listen(vin: string, l: CarListener): () => void {
    let set = this.listeners.get(vin);
    if (!set) this.listeners.set(vin, (set = new Set()));
    set.add(l);
    const waiting = this.linger.get(vin);
    if (waiting) { clearTimeout(waiting); this.linger.delete(vin); }
    let source = this.sources.get(vin);
    if (!source) {
      const car = this.cars().find((c) => c.vin === vin);
      const made = car ? this.make(car, (s) => this.emit(vin, s), (st) => this.tell(vin, st)) : null;
      if (made) { source = made; this.sources.set(vin, made); made.start(); }
    }
    l.state(source?.state ?? "stopped");
    return () => {
      set!.delete(l);
      if (set!.size || this.linger.has(vin)) return;
      this.linger.set(vin, setTimeout(() => {
        this.linger.delete(vin);
        if (this.listeners.get(vin)?.size) return;
        this.sources.get(vin)?.stop();
        this.sources.delete(vin);
      }, LINGER_MS).unref());
    };
  }

  emit(vin: string, s: CarSample) {
    for (const l of this.listeners.get(vin) ?? []) l.sample(s);
  }

  private tell(vin: string, state: string) {
    for (const l of this.listeners.get(vin) ?? []) l.state(state);
  }

  /** Every stream stopped (the account or the source changed): the pages still open start the new one as they reconnect. */
  reset() {
    for (const s of this.sources.values()) s.stop();
    this.sources.clear();
    for (const t of this.linger.values()) clearTimeout(t);
    this.linger.clear();
    for (const set of this.listeners.values()) for (const l of set) l.state("reset");
  }

  status(): Record<string, { listeners: number; state: string; lastError: string | null; lastSampleAgoS: number | null }> {
    const out: Record<string, { listeners: number; state: string; lastError: string | null; lastSampleAgoS: number | null }> = {};
    for (const car of this.cars()) {
      const s = this.sources.get(car.vin);
      out[car.vin] = {
        listeners: this.listeners.get(car.vin)?.size ?? 0,
        state: s?.state ?? "stopped",
        lastError: s?.lastError ?? null,
        lastSampleAgoS: s?.lastSampleAt ? Math.round((Date.now() - s.lastSampleAt) / 1000) : null,
      };
    }
    return out;
  }
}
