import type { Category, Fuel, Health, LonLat, Place, Poi, Provider, Route, StationDetail } from "./types";
import { threadRoute } from "./thread";

async function get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const answer = await fetch(url);
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok) throw new Error((body as { error?: string }).error ?? `${answer.status}`);
  return body as T;
}

const pair = (p: LonLat) => `${p[0]},${p[1]}`;

/** The car's way and speed, for a route asked on the move (main.ts sets it); none when standing. */
export let heading: () => { deg: number; kmh: number } | null = () => null;
export function setHeading(f: typeof heading) { heading = f; }
const moving = () => {
  const h = heading();
  return h ? { heading: String(Math.round(h.deg)), speed: String(Math.round(h.kmh)) } : {};
};

export const api = {
  health: () => get<Health>("/api/health", {}),
  search: (q: string, near?: LonLat) => get<Place[]>("/api/search", { q, near: near && pair(near) }),
  // Every route's corners threaded through the painted lanes where 정밀도로지도 has them (thread.ts).
  route: (provider: Provider, start: LonLat, goal: LonLat) =>
    get<Route>("/api/route", { provider, start: pair(start), goal: pair(goal), ...moving() }).then(threadRoute),
  routes: async (start: LonLat, goal: LonLat) => {
    const a = await get<{ routes: Route[]; errors: string[] }>("/api/route", { provider: "all", start: pair(start), goal: pair(goal), ...moving() });
    await Promise.all(a.routes.map(threadRoute));
    return a;
  },
  nearby: (category: Category, at: LonLat, radiusM: number, fuel?: Fuel) =>
    get<Poi[]>("/api/nearby", { cat: category, at: pair(at), r: String(Math.round(radiusM)), fuel }),
  here: (at: LonLat, radiusM: number, withAddress: boolean) =>
    get<{ places: Poi[]; address: { name: string; address: string } | null }>("/api/here", { at: pair(at), r: String(radiusM), address: withAddress ? "1" : undefined }),
  gasDetail: (uniId: string) => get<StationDetail>(`/api/nearby/gas/${encodeURIComponent(uniId)}`, {}),
};
