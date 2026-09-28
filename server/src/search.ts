import { askJson, type LonLat } from "./route/types.js";

/** A place the reader typed for: what to show, and where to route to. */
export interface Place {
  name: string;
  address: string;
  at: LonLat;
  category?: string;
  /** Metres from the car, when the car said where it was. */
  distanceM?: number;
}

/**
 * Kakao Local keyword search — the same REST key as Kakao Mobility. Sorted
 * by distance when the car's position comes along, which is what a driver
 * means by "the nearest 스타벅스".
 */
export class KakaoSearch {
  constructor(private restKey: () => string | undefined) {}
  get ready() {
    return !!this.restKey();
  }

  async find(query: string, near?: LonLat): Promise<Place[]> {
    const url = new URL("https://dapi.kakao.com/v2/local/search/keyword.json");
    url.searchParams.set("query", query);
    url.searchParams.set("size", "10");
    if (near) {
      url.searchParams.set("x", String(near[0]));
      url.searchParams.set("y", String(near[1]));
      url.searchParams.set("sort", "distance");
    }
    const answer = await askJson<{
      documents: {
        place_name: string;
        road_address_name: string;
        address_name: string;
        category_group_name: string;
        x: string;
        y: string;
        distance: string;
      }[];
    }>(url.toString(), { headers: { Authorization: `KakaoAK ${this.restKey()}` } }, "kakao");
    return answer.documents.map((d) => ({
      name: d.place_name,
      address: d.road_address_name || d.address_name,
      at: [Number(d.x), Number(d.y)],
      category: d.category_group_name || undefined,
      distanceM: d.distance ? Number(d.distance) : undefined,
    }));
  }
}
