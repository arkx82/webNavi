import type { LonLat } from "../route/types.js";
import type { Category, Poi } from "./types.js";
import { Cache, ask } from "./util.js";

/**
 * Kakao Local, for every kind of place without a price: its category
 * search where Kakao has a code for the kind, its keyword search where it
 * has not (chargers, rest areas). Nearest first, two pages of fifteen.
 */
const CODES: Partial<Record<Category, string>> = {
  gas: "OL7", parking: "PK6", food: "FD6", cafe: "CE7", cvs: "CS2",
  hospital: "HP8", pharmacy: "PM9", bank: "BK9",
};
const WORDS: Partial<Record<Category, string>> = { ev: "전기차충전소", rest: "휴게소" };
const MAX_RADIUS_M = 20_000;

interface Doc {
  id: string;
  place_name: string;
  category_name: string;
  phone: string;
  address_name: string;
  road_address_name: string;
  x: string;
  y: string;
  distance: string;
}

export class KakaoPlaces {
  private cache = new Cache<Poi[]>(3 * 60_000);
  private regions = new Cache<string | null>(24 * 3600_000, 2000);

  constructor(private restKey: () => string | undefined) {}
  get ready() {
    return !!this.restKey();
  }

  handles(category: Category): boolean {
    return category in CODES || category in WORDS;
  }

  async near(category: Category, at: LonLat, radiusM: number): Promise<Poi[]> {
    const r = Math.min(MAX_RADIUS_M, Math.max(100, Math.round(radiusM)));
    // Rounded to about 100 m: the same answer serves the next few seconds of driving.
    const key = `${category}:${at[0].toFixed(3)}:${at[1].toFixed(3)}:${r}`;
    return this.cache.get(key, async () => {
      const pages = await Promise.all([1, 2].map((page) => this.page(category, at, r, page)));
      const seen = new Set<string>();
      return pages.flat().filter((p) => !seen.has(p.id) && !!seen.add(p.id));
    });
  }

  private async page(category: Category, at: LonLat, radiusM: number, page: number): Promise<Poi[]> {
    const code = CODES[category];
    const url = new URL(`https://dapi.kakao.com/v2/local/search/${code ? "category" : "keyword"}.json`);
    if (code) url.searchParams.set("category_group_code", code);
    else url.searchParams.set("query", WORDS[category]!);
    url.searchParams.set("x", String(at[0]));
    url.searchParams.set("y", String(at[1]));
    url.searchParams.set("radius", String(radiusM));
    url.searchParams.set("sort", "distance");
    url.searchParams.set("size", "15");
    url.searchParams.set("page", String(page));
    const answer = await ask<{ documents: Doc[]; meta: { is_end: boolean } }>(url, this.auth(), "kakao");
    return answer.documents.map((d) => ({
      id: `kakao:${d.id}`,
      category,
      name: d.place_name,
      address: d.road_address_name || d.address_name,
      at: [Number(d.x), Number(d.y)] as LonLat,
      distanceM: d.distance ? Number(d.distance) : undefined,
      detail: finer(d.category_name),
      phone: d.phone || undefined,
    }));
  }

  /**
   * The five-digit 시군구 code (법정동) of a point, which is how the
   * charger feed is sliced. Null off the land.
   */
  async district(at: LonLat): Promise<string | null> {
    // A district is kilometres wide; 0.01° (about a kilometre) is close enough to share.
    const key = `${at[0].toFixed(2)}:${at[1].toFixed(2)}`;
    return this.regions.get(key, async () => {
      const url = new URL("https://dapi.kakao.com/v2/local/geo/coord2regioncode.json");
      url.searchParams.set("x", String(at[0]));
      url.searchParams.set("y", String(at[1]));
      const answer = await ask<{ documents: { region_type: string; code: string }[] }>(url, this.auth(), "kakao");
      const b = answer.documents.find((d) => d.region_type === "B");
      return b ? b.code.slice(0, 5) : null;
    });
  }

  private auth(): RequestInit {
    return { headers: { Authorization: `KakaoAK ${this.restKey()}` } };
  }
}

/** "음식점 > 한식 > 육류,고기" → "한식 · 육류,고기": the part after the kind the button already says. */
export function finer(categoryName: string): string | undefined {
  const parts = categoryName.split(">").map((s) => s.trim()).filter(Boolean);
  const rest = parts.slice(1, 3);
  return rest.length ? rest.join(" · ") : parts[0];
}
