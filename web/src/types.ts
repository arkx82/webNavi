/** Mirrors server/src/route/types.ts and search.ts — the wire shape. */

export type Provider = "tmap" | "kakao" | "naver" | "osrm" | "korea";
export type LonLat = [number, number];
export type Congestion = 0 | 1 | 2 | 3;

export interface Guide {
  at: LonLat;
  text: string;
  distanceM: number;
  turnType: number | string;
  /** The place the guide is at, where the provider names it apart from its text (Kakao: "신갈JC"). */
  name?: string;
}

export interface Segment {
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
  /** Index ranges into [path] on a motorway or car-only road (server/src/route/types.ts). */
  motorways?: [number, number][];
  /** Index ranges into [path] taken from 정밀도로지도's lanes (web/src/thread.ts): already on a lane, not to be snapped. */
  threaded?: [number, number][];
}

export interface Place {
  name: string;
  address: string;
  at: LonLat;
  category?: string;
  distanceM?: number;
}

export interface Health {
  ok: boolean;
  providers: Record<Provider, boolean>;
  safetyFeatures: number;
  search: boolean;
  tts: boolean;
  /** Which source answers fuel and chargers; null without any key. */
  nearby?: { gas: "opinet" | "kakao" | null; ev: "env" | "kakao" | null; places: boolean };
  /** Which road sources have a key: ITS incidents, 한국도로공사 rest areas, 기상특보. */
  road?: { incidents: boolean; restAreas: boolean; alerts: boolean };
  /** 정밀도로지도 tiles built on the server. */
  hdmap?: boolean;
}

// ---- nearby: mirrors server/src/nearby/types.ts ----

export type Category = "gas" | "ev" | "parking" | "food" | "cafe" | "cvs" | "hospital" | "pharmacy" | "bank" | "rest";
/** Opinet product codes: 휘발유, 고급휘발유, 경유, LPG. */
export type Fuel = "B027" | "B034" | "D047" | "K015";

export interface Price {
  won: number;
  unit: "L" | "kWh";
  label: string;
}

export interface Chargers {
  fastFree: number;
  fastTotal: number;
  slowFree: number;
  slowTotal: number;
  maxKw: number;
  operator: string;
  parkingFree?: boolean;
  useTime?: string;
  price?: Price;
}

export interface Poi {
  id: string;
  category: Category;
  name: string;
  address: string;
  at: LonLat;
  distanceM?: number;
  detail?: string;
  phone?: string;
  price?: Price;
  chargers?: Chargers;
}

export interface StationDetail {
  address: string;
  phone?: string;
  prices: Price[];
  extras: string[];
}
