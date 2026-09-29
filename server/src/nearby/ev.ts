import type { LonLat } from "../route/types.js";
import type { KakaoPlaces } from "./kakao.js";
import type { TmapRegions } from "./tmap-regions.js";
import type { Chargers, Poi, Price } from "./types.js";
import { Cache, ask, metresBetween } from "./util.js";

/**
 * Chargers from 한국환경공단's feed (data.go.kr, B552584/EvCharger), the
 * one every operator reports into: where, how strong, and whether each
 * one is free right now. There is no "near here" call, so the question
 * goes by district (시군구), found from Kakao, and the answer is kept a
 * few minutes — the free/busy states are the part that goes stale.
 *
 * Prices are not in the feed at all. The public operator's tariff is
 * set by the ministry and written below; any other operator's comes from
 * the /admin page, where the owner can type the ones they use.
 */
const BASE = "https://apis.data.go.kr/B552584/EvCharger/getChargerInfo";
const MAX_DISTRICTS = 4;

/**
 * 환경부 공공 충전기, from 2026-08-01: five steps by the charger's output
 * (이투데이 2026-08, 무공해차 통합누리집). Upper bounds in kW, exclusive.
 */
export const PUBLIC_TARIFF: { belowKw: number; won: number }[] = [
  { belowKw: 30, won: 295.0 },
  { belowKw: 50, won: 307.2 },
  { belowKw: 100, won: 325.6 },
  { belowKw: 200, won: 348.4 },
  { belowKw: Infinity, won: 393.1 },
];

/** Kinds of place whose chargers are for residents or staff, not a passing driver. */
const PRIVATE_KINDS = new Set(["H001", "H002", "H003", "H004", "H005", "G001", "G005", "G006"]);
/** AC 완속 and the slow DC combo; everything else counts as fast. */
const SLOW_TYPES = new Set(["02", "08"]);
/** Provinces renumbered in 2023–24; the feed has not always followed. */
const RENUMBERED: Record<string, string> = { "51": "42", "42": "51", "52": "45", "45": "52" };

interface Item {
  statNm: string;
  statId: string;
  chgerId: string;
  chgerType: string;
  addr: string;
  lat: string;
  lng: string;
  useTime?: string;
  busiId?: string;
  busiNm?: string;
  busiCall?: string;
  stat: string;
  output?: string;
  parkingFree?: string;
  limitYn?: string;
  kindDetail?: string;
  delYn?: string;
}

/** An operator's own rates, typed on /admin: a name to match and won per kWh. */
export interface Tariff {
  match: string;
  fast?: number;
  slow?: number;
}

/**
 * "GS차지비 380 250" per line: a word found in the operator's name, the
 * fast rate, and optionally the slow one. Anything else on a line is ignored.
 */
export function parseTariffs(text: string | undefined): Tariff[] {
  const out: Tariff[] = [];
  for (const line of (text ?? "").split(/\n|;/)) {
    const m = line.trim().match(/^(\S+)\s+(\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?/);
    if (m) out.push({ match: m[1], fast: Number(m[2]), slow: m[3] ? Number(m[3]) : undefined });
  }
  return out;
}

export function priceFor(operatorId: string, operatorName: string, kw: number, owned: Tariff[]): Price | undefined {
  const fast = kw >= 30;
  const mine = owned.find((t) => operatorName.includes(t.match) || operatorId === t.match);
  const label = `${fast ? "급속" : "완속"} ${Math.round(kw)}kW`;
  if (mine) {
    const won = fast ? mine.fast : mine.slow ?? mine.fast;
    if (won) return { won, unit: "kWh", label };
  }
  if (operatorId === "ME" || operatorName.includes("환경부") || operatorName.includes("환경공단")) {
    const step = PUBLIC_TARIFF.find((s) => kw < s.belowKw)!;
    return { won: step.won, unit: "kWh", label };
  }
  return undefined;
}

export class EvChargers {
  private byDistrict = new Cache<Poi[]>(4 * 60_000, 60);

  constructor(private key: () => string | undefined, private kakao: KakaoPlaces, private tmap: TmapRegions, private tariffs: () => string | undefined) {}
  /** Needs Kakao or TMAP too, for the district. */
  get ready() {
    return !!this.key() && (this.kakao.ready || this.tmap.ready);
  }

  /** The 시군구 code of a point: Kakao first, TMAP when Kakao is missing or refuses. */
  async districtOf(at: LonLat): Promise<string | null> {
    if (this.kakao.ready) {
      try { return await this.kakao.district(at); } catch { /* fall through */ }
    }
    if (this.tmap.ready) return this.tmap.district(at).catch(() => null);
    return null;
  }

  async near(at: LonLat, radiusM: number): Promise<Poi[]> {
    // The middle and four points toward the edge: a circle can cross a district line.
    const d = (radiusM * 0.7) / 111_320;
    const k = d / Math.cos((at[1] * Math.PI) / 180);
    const probes: LonLat[] = [at, [at[0], at[1] + d], [at[0] + k, at[1]], [at[0], at[1] - d], [at[0] - k, at[1]]];
    const codes = [...new Set((await Promise.all(probes.map((p) => this.districtOf(p)))).filter((c): c is string => !!c))];
    if (codes.length === 0) throw new Error("ev: could not tell which district this is (Kakao and TMAP both failed)");
    const stations = (await Promise.all(codes.slice(0, MAX_DISTRICTS).map((c) => this.district(c)))).flat();
    return stations
      .map((p) => ({ ...p, distanceM: metresBetween(at, p.at) }))
      .filter((p) => p.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM);
  }

  private district(code: string): Promise<Poi[]> {
    return this.byDistrict.get(code, async () => {
      let items = await this.fetchAll(code);
      const other = RENUMBERED[code.slice(0, 2)];
      if (items.length === 0 && other) items = await this.fetchAll(other + code.slice(2));
      return stationsOf(items, parseTariffs(this.tariffs()));
    });
  }

  private async fetchAll(zscode: string): Promise<Item[]> {
    const items: Item[] = [];
    for (let page = 1; page <= 5; page++) {
      const url = new URL(BASE);
      // data.go.kr hands out the key both raw and percent-encoded; either works here.
      url.searchParams.set("serviceKey", decodeURIComponent(this.key()!));
      url.searchParams.set("pageNo", String(page));
      url.searchParams.set("numOfRows", "9999");
      url.searchParams.set("dataType", "JSON");
      url.searchParams.set("zcode", zscode.slice(0, 2));
      url.searchParams.set("zscode", zscode);
      const answer = await ask<{ resultCode?: string; resultMsg?: string; totalCount?: number; items?: { item?: Item[] | Item } }>(url, {}, "ev");
      if (answer.resultCode && answer.resultCode !== "00") throw new Error(`ev: ${answer.resultCode} ${answer.resultMsg ?? ""}`);
      const raw = answer.items?.item;
      const got = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
      items.push(...got);
      if (got.length === 0 || items.length >= (answer.totalCount ?? 0)) break;
    }
    return items;
  }
}

/** One row per charger in, one place per station out, with its counts. */
export function stationsOf(items: Item[], owned: Tariff[]): Poi[] {
  const byId = new Map<string, { first: Item; all: Item[] }>();
  for (const item of items) {
    if (item.delYn === "Y" || item.limitYn === "Y" || PRIVATE_KINDS.has(item.kindDetail ?? "")) continue;
    if (!Number(item.lat) || !Number(item.lng)) continue;
    const kept = byId.get(item.statId);
    if (kept) kept.all.push(item);
    else byId.set(item.statId, { first: item, all: [item] });
  }
  const out: Poi[] = [];
  for (const [id, { first, all }] of byId) {
    const c: Chargers = { fastFree: 0, fastTotal: 0, slowFree: 0, slowTotal: 0, maxKw: 0, operator: first.busiNm ?? "" };
    for (const one of all) {
      const fast = !SLOW_TYPES.has(one.chgerType);
      const free = one.stat === "2";
      if (fast) { c.fastTotal++; if (free) c.fastFree++; }
      else { c.slowTotal++; if (free) c.slowFree++; }
      c.maxKw = Math.max(c.maxKw, Number(one.output) || (fast ? 50 : 7));
    }
    if (first.parkingFree) c.parkingFree = first.parkingFree === "Y";
    if (first.useTime) c.useTime = first.useTime;
    c.price = priceFor(first.busiId ?? "", c.operator, c.maxKw, owned);
    out.push({
      id: `ev:${id}`,
      category: "ev",
      name: first.statNm,
      address: first.addr,
      at: [Number(first.lng), Number(first.lat)],
      detail: c.operator,
      phone: first.busiCall || undefined,
      chargers: c,
      price: c.price,
    });
  }
  return out;
}
