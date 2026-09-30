import { Cache } from "../nearby/util.js";
import type { Feature } from "../safety/index.js";

/**
 * 한국도로공사's rest areas (data.ex.co.kr, its own key): where each is
 * (locationinfoRest), what its filling station charges now
 * (curStateStation) and what it has (restConvList). Two hundred or so in
 * all, so the page is handed every one and places them on its route
 * itself — a rest area 30 km on is worth knowing before the car is near.
 */
const BASE = "https://data.ex.co.kr/openapi";

export interface RestInfo {
  route?: string;
  /** 원/L now, at the rest area's own station. */
  gasoline?: number;
  diesel?: number;
  lpg?: number;
  /** The station's brand code (SK, GS, S-OIL, HD, AD …). */
  brand?: string;
  /** 수유실, 샤워실, 약국 … as the operator lists them. */
  amenities: string[];
}
export type RestArea = Feature & { rest: RestInfo };

type Row = Record<string, string | number | null | undefined>;

export class RestAreas {
  private places = new Cache<Row[]>(24 * 3600_000, 1);
  private prices = new Cache<Row[]>(3600_000, 1);
  private amenities = new Cache<Row[]>(24 * 3600_000, 1);

  constructor(private key: () => string | undefined) {}
  get ready() {
    return !!this.key();
  }

  async all(): Promise<RestArea[]> {
    const [places, prices, amenities] = await Promise.all([
      this.places.get("all", () => this.list("locationinfo/locationinfoRest")),
      this.prices.get("all", () => this.list("business/curStateStation")).catch(() => [] as Row[]),
      this.amenities.get("all", () => this.list("restinfo/restConvList")).catch(() => [] as Row[]),
    ]);
    return restAreas(places, prices, amenities);
  }

  /** Every page of one list; the service says how many there are. */
  private async list(path: string): Promise<Row[]> {
    const PAGE = 99;
    const rows: Row[] = [];
    for (let page = 1; page <= 50; page++) {
      const url = new URL(`${BASE}/${path}`);
      url.searchParams.set("key", this.key()!);
      url.searchParams.set("type", "json");
      url.searchParams.set("numOfRows", String(PAGE));
      url.searchParams.set("pageNo", String(page));
      const answer = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const text = await answer.text();
      let body: { list?: Row[]; count?: number | string; pageSize?: number | string; code?: string; message?: string };
      try { body = JSON.parse(text); } catch { throw new Error(`ex: ${answer.status} ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}`); }
      if (body.code && body.code !== "SUCCESS") throw new Error(`ex: ${body.code} ${body.message ?? ""}`);
      rows.push(...(body.list ?? []));
      const pages = Number(body.pageSize ?? 1);
      if (!body.list?.length || page >= pages) break;
    }
    return rows;
  }
}

const won = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
/** "서울만남(부산)휴게소" and "서울만남(부산)주유소" are one place. */
const stem = (name: unknown) => String(name ?? "").replace(/\s+/g, "").replace(/(휴게소|주유소|충전소)$/, "");

export function restAreas(places: Row[], prices: Row[], amenities: Row[]): RestArea[] {
  const priceOf = new Map<string, Row>();
  for (const p of prices) priceOf.set(stem(p.serviceAreaName), p);
  const hasOf = new Map<string, Set<string>>();
  for (const a of amenities) {
    const code = String(a.stdRestCd ?? "");
    const name = String(a.psName ?? "").trim();
    if (!code || !name) continue;
    const set = hasOf.get(code) ?? new Set<string>();
    set.add(name);
    hasOf.set(code, set);
  }
  const out: RestArea[] = [];
  for (const r of places) {
    const lon = Number(r.xValue), lat = Number(r.yValue);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !lon || !lat) continue;
    const price = priceOf.get(stem(r.unitName));
    out.push({
      id: `rest:${r.stdRestCd ?? r.unitCode}`,
      kind: "rest-area",
      lon, lat,
      name: String(r.unitName ?? "휴게소"),
      detail: String(r.routeName ?? "") || undefined,
      rest: {
        route: String(r.routeName ?? "") || undefined,
        gasoline: won(price?.gasolinePrice),
        diesel: won(price?.diselPrice),
        lpg: price?.lpgYn === "Y" ? won(price?.lpgPrice) : undefined,
        brand: price?.oilCompany ? String(price.oilCompany) : undefined,
        amenities: [...(hasOf.get(String(r.stdRestCd ?? "")) ?? [])],
      },
    });
  }
  return out;
}
