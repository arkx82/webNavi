/** One shape for every provider's answer, so the client never sees three. */

export type Provider = "tmap" | "kakao" | "naver";

/** [lon, lat] — GeoJSON order, which is what MapLibre and Turf take. */
export type LonLat = [number, number];

/** 0 unknown, 1 free-flowing, 2 slow, 3 congested. Providers are mapped onto this. */
export type Congestion = 0 | 1 | 2 | 3;

export interface Guide {
  at: LonLat;
  text: string;
  /** Metres from this point to the next guide. */
  distanceM: number;
  /** Provider's own turn code, kept for the icon table. */
  turnType: number | string;
}

export interface Segment {
  /** Index range into [Route.path], inclusive start, exclusive end. */
  from: number;
  to: number;
  congestion: Congestion;
}

export interface Route {
  provider: Provider;
  distanceM: number;
  durationS: number;
  path: LonLat[];
  guides: Guide[];
  segments: Segment[];
}

export interface RouteRequest {
  start: LonLat;
  goal: LonLat;
}

export interface RouteProvider {
  readonly name: Provider;
  /** False when its key is not set; the client hides it. */
  readonly ready: boolean;
  route(request: RouteRequest): Promise<Route>;
}

export class ProviderError extends Error {
  constructor(public provider: Provider, public status: number, message: string) {
    super(`${provider}: ${message}`);
  }
}

export async function askJson<T>(url: string, init: RequestInit, provider: Provider): Promise<T> {
  const answer = await fetch(url, init);
  if (!answer.ok) {
    throw new ProviderError(provider, answer.status, (await answer.text()).slice(0, 500));
  }
  return (await answer.json()) as T;
}
