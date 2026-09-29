import type { LonLat } from "../route/types.js";
import { Cache } from "../nearby/util.js";
import { metres, type Feature } from "./index.js";

/**
 * 한국도로교통공단's accident hotspots — where crashes cluster, by year —
 * for cars and for bicycles (data.go.kr B552061, each its own 활용신청 on
 * the same key). Asked by district (시도 + 시군구, the 법정동 code's first
 * five digits) and kept a week: the list changes once a year.
 *
 * Each spot comes as a small circle drawn as a polygon; it is kept as its
 * centre and radius, so a route through its edge still counts.
 */
const SETS = [
  { kind: "accident" as const, path: "frequentzoneLg/getRestFrequentzoneLg" },
  { kind: "bike-accident" as const, path: "frequentzoneBicycle/getRestFrequentzoneBicycle" },
];

interface Spot {
  afos_fid: number | string;
  spot_nm?: string;
  occrrnc_cnt?: number;
  geom_json?: string;
  la_crd?: string | number;
  lo_crd?: string | number;
}

export class Hotspots {
  private byDistrict = new Cache<Feature[]>(7 * 86_400_000, 300);

  constructor(private key: () => string | undefined, private districtOf: (at: LonLat) => Promise<string | null>) {}
  get ready() {
    return !!this.key();
  }

  /** Spots within [radiusM] of the point, from its district and those the circle reaches. */
  async near(at: LonLat, radiusM: number): Promise<(Feature & { distanceM: number })[]> {
    const d = (radiusM * 0.7) / 111_320;
    const k = d / Math.cos((at[1] * Math.PI) / 180);
    const probes: LonLat[] = [at, [at[0], at[1] + d], [at[0] + k, at[1]], [at[0], at[1] - d], [at[0] - k, at[1]]];
    const codes = [...new Set((await Promise.all(probes.map((p) => this.districtOf(p).catch(() => null)))).filter((c): c is string => !!c))];
    const all = (await Promise.all(codes.map((c) => this.district(c).catch(() => [] as Feature[])))).flat();
    return all
      .map((f) => ({ ...f, distanceM: Math.round(Math.max(0, metres(at[0], at[1], f.lon, f.lat) - (f.radiusM ?? 0))) }))
      .filter((f) => f.distanceM <= radiusM);
  }

  private district(code: string): Promise<Feature[]> {
    return this.byDistrict.get(code, async () => {
      const out: Feature[] = [];
      for (const set of SETS) out.push(...(await this.latest(set.kind, set.path, code)));
      return out;
    });
  }

  /** The most recent year that has data: last year's list comes out some months in. */
  private async latest(kind: Feature["kind"], path: string, code: string): Promise<Feature[]> {
    const year = new Date().getFullYear();
    for (const y of [year - 1, year - 2, year - 3]) {
      const url = new URL(`https://apis.data.go.kr/B552061/${path}`);
      url.searchParams.set("serviceKey", decodeURIComponent(this.key()!));
      url.searchParams.set("searchYearCd", String(y));
      url.searchParams.set("siDo", code.slice(0, 2));
      url.searchParams.set("guGun", code.slice(2, 5));
      url.searchParams.set("type", "json");
      url.searchParams.set("numOfRows", "100");
      url.searchParams.set("pageNo", "1");
      const answer = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = (await answer.json().catch(() => ({}))) as { resultCode?: string; items?: { item?: Spot[] | Spot } };
      const raw = body.items?.item;
      const spots = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
      if (spots.length) return spots.map((s) => spotFeature(kind, s)).filter((f): f is Feature => !!f);
    }
    return [];
  }
}

/** A spot's circle as its centre and radius, from the polygon (or the centre the row gives). */
export function spotFeature(kind: Feature["kind"], s: Spot): Feature | null {
  let ring: LonLat[] = [];
  try { ring = (JSON.parse(s.geom_json ?? "{}") as { coordinates?: LonLat[][] }).coordinates?.[0] ?? []; } catch { /* no shape */ }
  let lon = Number(s.lo_crd), lat = Number(s.la_crd);
  if (ring.length) {
    lon = ring.reduce((a, p) => a + p[0], 0) / ring.length;
    lat = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  }
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !lon || !lat) return null;
  const radiusM = ring.length ? Math.max(...ring.map((p) => metres(lon, lat, p[0], p[1]))) : 100;
  return { id: `${kind}:${s.afos_fid}`, kind, lon, lat, name: s.spot_nm, radiusM: Math.round(radiusM) };
}
