import type { LonLat } from "../route/types.js";
import { Cache, ask } from "./util.js";

/**
 * The district (시군구) of a point from TMAP's reverse geocoding, for the
 * charger feed when Kakao cannot say — its key missing, or its app not
 * yet allowed the map and local service.
 */
export class TmapRegions {
  private cache = new Cache<string | null>(24 * 3600_000, 2000);

  constructor(private appKey: () => string | undefined) {}
  get ready() {
    return !!this.appKey();
  }

  district(at: LonLat): Promise<string | null> {
    return this.cache.get(`${at[0].toFixed(2)}:${at[1].toFixed(2)}`, async () => {
      const url = new URL("https://apis.openapi.sk.com/tmap/geo/reversegeocoding");
      url.searchParams.set("version", "1");
      url.searchParams.set("lat", String(at[1]));
      url.searchParams.set("lon", String(at[0]));
      url.searchParams.set("coordType", "WGS84GEO");
      url.searchParams.set("addressType", "A10");
      const answer = await ask<{ addressInfo?: { legalDongCode?: string } }>(url, { headers: { appKey: this.appKey()! } }, "tmap");
      const code = answer.addressInfo?.legalDongCode;
      return code && code.length >= 5 ? code.slice(0, 5) : null;
    });
  }
}
