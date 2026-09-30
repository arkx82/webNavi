/** One shape for every provider's answer, so the client never sees three. */

/** korea: our own OSRM over 표준노드링크 (tools/nodelink/build.py), served by docker compose's osrm service. */
export type Provider = "tmap" | "kakao" | "naver" | "osrm" | "korea";

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
  /** The place the guide is at, where the provider names it apart from its text (Kakao: "신갈JC"). */
  name?: string;
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
  /**
   * Index ranges into [path] (from inclusive, to exclusive) on a road no
   * pedestrian is on — 고속도로, 도시고속도로, 자동차전용도로 (동부간선,
   * 강변북로 …). No school zone or speed bump is there, whatever is beside it.
   */
  motorways?: [number, number][];
}

/**
 * Whether a road, by its name, is a motorway or a car-only road. Kakao and
 * NAVER give names only; TMAP gives its road class too (roadType 0 고속국도,
 * 1 도시고속화도로), checked first where it has one.
 */
const MOTORWAY_NAME = /고속도로|고속화|도시고속|순환고속|자동차전용|간선도로|내부순환|외곽순환|강남순환|강변북로|올림픽대로|자유로|수도권제\d순환|순환선$|고속국도|제\d경인|분당수서|신월여의|서해안선|경부선|영동선|중부선/;
export function isMotorwayName(name: string | undefined | null): boolean {
  return !!name && MOTORWAY_NAME.test(name.replace(/\s+/g, ""));
}

/** Adds [from, to) to [route.motorways], joining it to the last range where they touch. */
export function markMotorway(route: Route, from: number, to: number) {
  if (to <= from) return;
  const list = (route.motorways ??= []);
  const last = list[list.length - 1];
  if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
  else list.push([from, to]);
}

export interface RouteRequest {
  start: LonLat;
  goal: LonLat;
  /**
   * The way the car is heading at the start (degrees from north), when it
   * is moving: a car already on 동부간선 is routed from its own carriageway,
   * not the service road beside it. Kakao honours it; TMAP is given it too.
   */
  heading?: number;
  speedKmh?: number;
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

/** A route that has not come in this long is not waited for: a re-route is asked on the move. */
export const ROUTE_TIMEOUT_MS = 7000;

export async function askJson<T>(url: string, init: RequestInit, provider: Provider): Promise<T> {
  let answer: Response;
  try {
    answer = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(ROUTE_TIMEOUT_MS) });
  } catch (e) {
    const timedOut = (e as Error).name === "TimeoutError";
    throw new ProviderError(provider, timedOut ? 504 : 502, timedOut ? `no answer in ${ROUTE_TIMEOUT_MS / 1000} s` : (e as Error).message);
  }
  if (!answer.ok) {
    throw new ProviderError(provider, answer.status, (await answer.text()).slice(0, 500));
  }
  return (await answer.json()) as T;
}
