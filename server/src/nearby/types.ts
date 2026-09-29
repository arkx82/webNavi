import type { LonLat } from "../route/types.js";

/**
 * The kinds of place the car apps put a button on. Each one is a Kakao
 * category code, except the two that carry a price: fuel comes from Opinet
 * (with the price of the chosen fuel) and chargers from the environment
 * ministry's feed (with how many are free), each falling back to Kakao
 * when its key is missing.
 */
export type Category = "gas" | "ev" | "parking" | "food" | "cafe" | "cvs" | "hospital" | "pharmacy" | "bank" | "rest";
export const CATEGORIES: Category[] = ["gas", "ev", "parking", "food", "cafe", "cvs", "hospital", "pharmacy", "bank", "rest"];

/** Opinet product codes: 휘발유, 고급휘발유, 경유, LPG. */
export type Fuel = "B027" | "B034" | "D047" | "K015";
export const FUELS: Record<Fuel, string> = { B027: "휘발유", B034: "고급휘발유", D047: "경유", K015: "LPG" };

export interface Price {
  /** Won per unit. */
  won: number;
  unit: "L" | "kWh";
  /** What it is the price of: "휘발유", "급속 100kW". */
  label: string;
}

export interface Chargers {
  fastFree: number;
  fastTotal: number;
  slowFree: number;
  slowTotal: number;
  /** The strongest charger there, in kW. */
  maxKw: number;
  operator: string;
  parkingFree?: boolean;
  useTime?: string;
  /** Won per kWh at the strongest charger, where the operator's tariff is known. */
  price?: Price;
}

export interface Poi {
  /** Unique within its source: "opinet:A0010207", "kakao:12345", "ev:ME174001". */
  id: string;
  category: Category;
  name: string;
  address: string;
  at: LonLat;
  distanceM?: number;
  /** The finer kind ("한식 · 육류,고기") or the brand ("SK에너지"). */
  detail?: string;
  phone?: string;
  price?: Price;
  chargers?: Chargers;
}

export interface NearbyQuery {
  category: Category;
  at: LonLat;
  radiusM: number;
  fuel?: Fuel;
}
