import type { LonLat } from "../route/types.js";
import { fromKatec, toKatec } from "./katec.js";
import { FUELS, type Fuel, type Poi, type Price } from "./types.js";
import { Cache, ask, metresBetween } from "./util.js";

/**
 * Opinet (한국석유공사): every station's price, as the station reported
 * it, which is where every Korean car app gets its fuel prices. Coordinates
 * go in and come out in KATEC. The radius is at most 5 km; one call answers
 * for one fuel, so the list is always "휘발유 prices", never a mix.
 */
const BASE = "https://www.opinet.co.kr/api";
const MAX_RADIUS_M = 5000;

export const BRANDS: Record<string, string> = {
  SKE: "SK에너지", GSC: "GS칼텍스", HDO: "HD현대오일뱅크", SOL: "S-OIL",
  RTE: "자영알뜰", RTX: "고속도로알뜰", NHO: "농협알뜰", ETC: "자가상표",
  E1G: "E1", SKG: "SK가스", RTO: "알뜰주유소",
};

interface Row {
  UNI_ID: string;
  POLL_DIV_CD?: string;
  POLL_DIV_CO?: string;
  OS_NM: string;
  PRICE: string | number;
  DISTANCE?: string | number;
  GIS_X_COOR: string | number;
  GIS_Y_COOR: string | number;
}

interface DetailRow extends Row {
  NEW_ADR?: string;
  VAN_ADR?: string;
  TEL?: string;
  CAR_WASH_YN?: string;
  CVS_YN?: string;
  MAINT_YN?: string;
  OIL_PRICE?: { PRODCD: string; PRICE: string | number }[] | { PRODCD: string; PRICE: string | number };
}

export interface StationDetail {
  address: string;
  phone?: string;
  prices: Price[];
  /** 세차, 편의점, 경정비 — what the station says it has. */
  extras: string[];
}

export class Opinet {
  // Prices change a few times a day; ten minutes keeps a drive through
  // one area to one call per fuel.
  private around = new Cache<Poi[]>(10 * 60_000);
  private details = new Cache<StationDetail>(30 * 60_000);

  constructor(private key: () => string | undefined) {}
  get ready() {
    return !!this.key();
  }

  async near(at: LonLat, radiusM: number, fuel: Fuel): Promise<Poi[]> {
    const r = Math.min(MAX_RADIUS_M, Math.max(500, Math.round(radiusM)));
    const [x, y] = toKatec(at);
    // Rounded to 200 m so a moving car reuses the answer.
    const cacheKey = `${fuel}:${Math.round(x / 200)}:${Math.round(y / 200)}:${r}`;
    const rows = await this.around.get(cacheKey, async () => {
      const answer = await this.call<{ RESULT?: { OIL?: Row[] } }>("aroundAll.do", {
        x: x.toFixed(1), y: y.toFixed(1), radius: String(r), prodcd: fuel, sort: "1",
      });
      return (answer.RESULT?.OIL ?? []).map((row) => this.poi(row, fuel));
    });
    // Distances are from the rounded point; say them from the car.
    return rows.map((p) => ({ ...p, distanceM: metresBetween(at, p.at) }));
  }

  /** Every fuel's price at one station, and its address and phone, which the list call leaves out. */
  async detail(uniId: string): Promise<StationDetail> {
    return this.details.get(uniId, async () => {
      const answer = await this.call<{ RESULT?: { OIL?: DetailRow[] } }>("detailById.do", { id: uniId });
      const row = answer.RESULT?.OIL?.[0];
      if (!row) throw new Error(`opinet: no station ${uniId}`);
      const raw = row.OIL_PRICE == null ? [] : Array.isArray(row.OIL_PRICE) ? row.OIL_PRICE : [row.OIL_PRICE];
      const prices: Price[] = [];
      for (const code of Object.keys(FUELS) as Fuel[]) {
        const p = raw.find((r) => r.PRODCD === code);
        const won = Number(p?.PRICE);
        if (p && won > 0) prices.push({ won, unit: "L", label: FUELS[code] });
      }
      const extras = [row.CAR_WASH_YN === "Y" && "세차", row.CVS_YN === "Y" && "편의점", row.MAINT_YN === "Y" && "경정비"]
        .filter((e): e is string => !!e);
      return { address: row.NEW_ADR || row.VAN_ADR || "", phone: row.TEL?.trim() || undefined, prices, extras };
    });
  }

  private poi(row: Row, fuel: Fuel): Poi {
    const brand = row.POLL_DIV_CD ?? row.POLL_DIV_CO ?? "";
    const won = Number(row.PRICE);
    return {
      id: `opinet:${row.UNI_ID}`,
      category: "gas",
      name: row.OS_NM,
      address: "",
      at: fromKatec([Number(row.GIS_X_COOR), Number(row.GIS_Y_COOR)]),
      detail: BRANDS[brand] ?? brand,
      price: won > 0 ? { won, unit: "L", label: FUELS[fuel] } : undefined,
    };
  }

  private call<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE}/${path}`);
    url.searchParams.set("out", "json");
    // The published pages say certkey; older examples say code. Both are sent.
    url.searchParams.set("certkey", this.key()!);
    url.searchParams.set("code", this.key()!);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return ask<T>(url, {}, "opinet");
  }
}
