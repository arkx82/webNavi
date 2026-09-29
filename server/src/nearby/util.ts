import type { LonLat } from "../route/types.js";

/**
 * Answers kept for a while under a key, and one call in flight per key:
 * a car that asks the same corner twice in a second pays for it once.
 * Old entries go when there are too many, oldest first.
 */
export class Cache<T> {
  private kept = new Map<string, { at: number; value: Promise<T> }>();

  constructor(private ttlMs: number, private max = 300) {}

  get(key: string, make: () => Promise<T>): Promise<T> {
    const hit = this.kept.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = make();
    this.kept.set(key, { at: Date.now(), value });
    // A failure is not kept: the next ask tries again.
    value.catch(() => { if (this.kept.get(key)?.value === value) this.kept.delete(key); });
    if (this.kept.size > this.max) this.kept.delete(this.kept.keys().next().value!);
    return value;
  }
}

export class NearbyError extends Error {
  constructor(public source: string, public status: number, message: string) {
    super(`${source}: ${message}`);
  }
}

export async function ask<T>(url: URL | string, init: RequestInit, source: string): Promise<T> {
  const answer = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  const text = await answer.text();
  if (!answer.ok) throw new NearbyError(source, answer.status, text.slice(0, 300));
  try {
    return JSON.parse(text) as T;
  } catch {
    // data.go.kr answers a bad key with XML whatever was asked for.
    throw new NearbyError(source, 502, text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300));
  }
}

export function metresBetween(a: LonLat, b: LonLat): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}
