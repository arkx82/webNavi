import type { Avoid, Category, Fuel, Health, LonLat, Place, Poi, Provider, Route, StationDetail } from "./types";
import { threadRoute } from "./thread";

/** Corners through the painted lanes where 정밀도로지도 has them (quick: only the turns). The whole line goes onto the lanes when a route is driven (main.ts). */
const onLanes = (r: Route) => threadRoute(r);

async function get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const answer = await fetch(url);
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok) throw new Error((body as { error?: string }).error ?? `${answer.status}`);
  return body as T;
}

const pair = (p: LonLat) => `${p[0]},${p[1]}`;

async function post<T>(path: string, body: unknown): Promise<T> {
  const answer = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const got = await answer.json().catch(() => ({}));
  if (!answer.ok) throw new Error((got as { error?: string }).error ?? `${answer.status}`);
  return got as T;
}

/** A stretch of a route at one limit, as path positions (vertex index + fraction): server/src/road/limits.ts. */
export interface LimitRun { from: number; to: number; kmh: number; src: "tmap" | "nodelink" }

/** The car's way and speed, for a route asked on the move (main.ts sets it); none when standing. */
export let heading: () => { deg: number; kmh: number } | null = () => null;
export function setHeading(f: typeof heading) { heading = f; }
const moving = () => {
  const h = heading();
  return h ? { heading: String(Math.round(h.deg)), speed: String(Math.round(h.kmh)) } : {};
};

/**
 * What every route asked keeps off (main.ts sets it: 무료도로 우선 on the route sheet, 어린이 보호구역 회피 in 안내 설정):
 * here, so a re-route, a quicker-way check or a resumed drive asks the same as the ways first chosen.
 */
export let avoiding: () => Avoid[] = () => [];
export function setAvoiding(f: typeof avoiding) { avoiding = f; }
const avoidParam = () => {
  const a = avoiding();
  return a.length ? { avoid: a.join(",") } : {};
};

export const api = {
  health: () => get<Health>("/api/health", {}),
  search: (q: string, near?: LonLat) => get<Place[]>("/api/search", { q, near: near && pair(near) }),
  // Every route's corners threaded through the painted lanes where 정밀도로지도 has them (thread.ts).
  route: (provider: Provider, start: LonLat, goal: LonLat) =>
    get<Route>("/api/route", { provider, start: pair(start), goal: pair(goal), ...moving(), ...avoidParam() }).then(onLanes),
  routes: async (start: LonLat, goal: LonLat) => {
    const a = await get<{ routes: Route[]; errors: string[]; pending?: Provider[] }>("/api/route", { provider: "all", start: pair(start), goal: pair(goal), ...moving(), ...avoidParam() });
    await Promise.all(a.routes.map(onLanes));
    return a;
  },
  nearby: (category: Category, at: LonLat, radiusM: number, fuel?: Fuel) =>
    get<Poi[]>("/api/nearby", { cat: category, at: pair(at), r: String(Math.round(radiusM)), fuel }),
  here: (at: LonLat, radiusM: number, withAddress: boolean) =>
    get<{ places: Poi[]; address: { name: string; address: string } | null }>("/api/here", { at: pair(at), r: String(radiusM), address: withAddress ? "1" : undefined }),
  /** The route's speed limits all the way (TMAP's road matching, 표준노드링크 where it has none). */
  limits: (path: LonLat[]) => post<{ runs: LimitRun[]; tmapShare: number }>("/api/road/limits", { path }),
  /** The limit where a car off any route is, running [deg]. */
  limitHere: (at: LonLat, deg: number | null) =>
    get<{ kmh: number | null; src: "tmap" | "nodelink" | null }>("/api/road/limit", { at: pair(at), deg: deg == null ? undefined : String(Math.round(deg)) }),
  gasDetail: (uniId: string) => get<StationDetail>(`/api/nearby/gas/${encodeURIComponent(uniId)}`, {}),
};
