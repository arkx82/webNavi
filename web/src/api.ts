import type { Health, LonLat, Place, Provider, Route } from "./types";

async function get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const answer = await fetch(url);
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok) throw new Error((body as { error?: string }).error ?? `${answer.status}`);
  return body as T;
}

const pair = (p: LonLat) => `${p[0]},${p[1]}`;

export const api = {
  health: () => get<Health>("/api/health", {}),
  search: (q: string, near?: LonLat) => get<Place[]>("/api/search", { q, near: near && pair(near) }),
  route: (provider: Provider, start: LonLat, goal: LonLat) =>
    get<Route>("/api/route", { provider, start: pair(start), goal: pair(goal) }),
  routes: (start: LonLat, goal: LonLat) =>
    get<{ routes: Route[]; errors: string[] }>("/api/route", { provider: "all", start: pair(start), goal: pair(goal) }),
};
