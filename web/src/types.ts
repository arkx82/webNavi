/** Mirrors server/src/route/types.ts and search.ts — the wire shape. */

export type Provider = "tmap" | "kakao" | "naver";
export type LonLat = [number, number];
export type Congestion = 0 | 1 | 2 | 3;

export interface Guide {
  at: LonLat;
  text: string;
  distanceM: number;
  turnType: number | string;
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
}
