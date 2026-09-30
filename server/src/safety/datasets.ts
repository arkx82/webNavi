import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import proj4 from "proj4";
import type { Feature } from "./index.js";
import type { SecretName } from "../settings.js";

/**
 * The national lists too big to ask on the way — every speed bump
 * (행정안전부 과속방지턱정보, 1741000) and every school zone (전국어린이보호구역
 * 표준데이터) — fetched whole through data.go.kr's API on the same key,
 * kept beside the settings, and asked again when a week old, the way the
 * camera list is (cameras.ts). Each is its own 활용신청.
 */
export const DATASET_MAX_AGE_MS = 7 * 86_400_000;

export interface KeptSet {
  at: number;
  features: Feature[];
}

export interface Dataset {
  /** The file under the config directory, and the name in the logs. */
  name: "bumps" | "school-zones" | "lights" | "seoul-lights" | "senior-zones";
  label: string;
  /** The key it is asked with; the data.go.kr one unless said. */
  keyName?: SecretName;
  fetch: (key: string) => Promise<Feature[]>;
}

export function kept(dir: string, name: Dataset["name"]): KeptSet | null {
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as KeptSet; } catch { return null; }
}

export async function refresh(set: Dataset, key: string, dir: string): Promise<KeptSet> {
  const features = await set.fetch(key);
  // An empty list is a failure to say so, not a week's answer to keep.
  if (features.length === 0) throw new Error(`${set.name}: the API answered nothing`);
  const out: KeptSet = { at: Date.now(), features };
  writeFileSync(join(dir, `${set.name}.json`), JSON.stringify(out));
  return out;
}

type Row = Record<string, string | number | null | undefined>;

/**
 * Every page of a data.go.kr list, a few at a time. The gateway's two
 * answer shapes (wrapped in "response" or not) and its refusal (a key not
 * yet allowed the dataset, in XML-ish JSON of its own) are all read here.
 */
async function allPages(url: (page: number) => URL, pageSize: number, label: string, parallel = 4): Promise<Row[]> {
  const first = await page(url(1), label);
  const total = first.total;
  const rows = [...first.rows];
  const pages = Math.ceil(total / pageSize);
  for (let p = 2; p <= pages; p += parallel) {
    const batch = await Promise.all(Array.from({ length: Math.min(parallel, pages - p + 1) }, (_, i) => page(url(p + i), label)));
    for (const b of batch) rows.push(...b.rows);
  }
  return rows;
}

async function page(url: URL, label: string): Promise<{ rows: Row[]; total: number }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const answer = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const text = await answer.text();
      let raw: { response?: Body; OpenAPI_ServiceResponse?: { cmmMsgHeader?: { returnAuthMsg?: string; errMsg?: string } } } & Body;
      try { raw = JSON.parse(text); } catch { throw new Error(`${answer.status} ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}`); }
      const refused = raw.OpenAPI_ServiceResponse?.cmmMsgHeader;
      if (refused) throw new Refused(`${label}: ${refused.returnAuthMsg ?? refused.errMsg} — data.go.kr 활용신청 필요`);
      const body = raw.response ?? raw;
      const code = body.header?.resultCode;
      // "00" from most services, "0" from 행정안전부's newer ones; "03" is no more rows.
      if (code && !/^0+$/.test(code) && code !== "03") throw new Error(`${code} ${body.header?.resultMsg ?? ""}`);
      const items = body.body?.items;
      const list = (Array.isArray(items) ? items : items?.item) as Row[] | Row | undefined;
      return { rows: list == null ? [] : Array.isArray(list) ? list : [list], total: Number(body.body?.totalCount ?? 0) };
    } catch (e) {
      // A refusal will not change on a retry; a slow page might.
      if (e instanceof Refused || attempt >= 2) throw e instanceof Refused ? e : new Error(`${label}: ${(e as Error).message}`);
      await new Promise((done) => setTimeout(done, 2000 * (attempt + 1)));
    }
  }
}

class Refused extends Error {}
type Body = { header?: { resultCode?: string; resultMsg?: string }; body?: { items?: Row[] | { item?: Row[] | Row }; totalCount?: string | number } };

const num = (v: unknown) => (v == null || v === "" ? NaN : Number(v));
const serviceKey = (key: string) => decodeURIComponent(key);

/** 과속방지턱정보: WGS84 already. Rows marked deleted (DAT_UPDT_SE D) are the bumps taken out. */
export const BUMPS: Dataset = {
  name: "bumps",
  label: "과속방지턱",
  async fetch(key) {
    const PAGE = 100; // the service's own cap, whatever is asked
    const rows = await allPages((p) => {
      const url = new URL("https://apis.data.go.kr/1741000/speed_bump_info/info");
      url.searchParams.set("serviceKey", serviceKey(key));
      url.searchParams.set("pageNo", String(p));
      url.searchParams.set("numOfRows", String(PAGE));
      url.searchParams.set("type", "json");
      return url;
    }, PAGE, "과속방지턱", 6);
    return bumpFeatures(rows);
  },
};

export function bumpFeatures(rows: Row[]): Feature[] {
  const out: Feature[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.DAT_UPDT_SE === "D") continue;
    const lat = num(r.WGS84_LAT), lon = num(r.WGS84_LOT);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !lat || !lon) continue;
    const id = `bump:${r.MNG_NO ?? `${lon},${lat}`}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, kind: "bump", lon, lat, name: String(r.ROAD_NM || r.INSTL_PLC || "") || undefined });
  }
  return out;
}

/**
 * 어린이보호구역: the facility's place, not the zone's outline. The page
 * turns it into a stretch of its route beside the school (warnings.ts),
 * and never on a motorway. The limit is 30 unless the road says otherwise,
 * which the data does not.
 */
export const SCHOOL_ZONES: Dataset = {
  name: "school-zones",
  label: "어린이 보호구역",
  async fetch(key) {
    const PAGE = 1000;
    const rows = await allPages((p) => {
      const url = new URL("https://api.data.go.kr/openapi/tn_pubr_public_child_prtc_zn_api");
      url.searchParams.set("serviceKey", serviceKey(key));
      url.searchParams.set("pageNo", String(p));
      url.searchParams.set("numOfRows", String(PAGE));
      url.searchParams.set("type", "json");
      return url;
    }, PAGE, "어린이 보호구역");
    return schoolZoneFeatures(rows);
  },
};

/** [limitOf] gives a row's limit where the list has one a row (the senior zones'); school zones are 30. */
export function schoolZoneFeatures(rows: Row[], limitOf: (r: Row) => number | undefined = () => 30): Feature[] {
  const out: Feature[] = [];
  rows.forEach((r, n) => {
    const lat = num(r.latitude), lon = num(r.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !lat || !lon) return;
    out.push({
      id: `school-zone:${r.insttCode ?? ""}:${r.trgetFcltyNm ?? n}:${lon.toFixed(4)}`,
      kind: "school-zone",
      lon, lat,
      limit: limitOf(r),
      name: String(r.trgetFcltyNm ?? "") || undefined,
      detail: String(r.fcltyKnd ?? "") || undefined,
    });
  });
  return out;
}

/**
 * 전국신호등표준데이터: the lamps for vehicles (신호등구분 1) and the
 * flashing-yellow ones (6), with the hours a light is switched to flashing
 * at night where the operator sets them (점멸운영 Y, 개시·종료 시각). Walk
 * signals and the rest are left out. Seoul is only 동작구 in it.
 */
export const LIGHTS: Dataset = {
  name: "lights",
  label: "신호등",
  async fetch(key) {
    const PAGE = 1000;
    const rows = await allPages((p) => {
      const url = new URL("https://api.data.go.kr/openapi/tn_pubr_public_traffic_light_api");
      url.searchParams.set("serviceKey", serviceKey(key));
      url.searchParams.set("pageNo", String(p));
      url.searchParams.set("numOfRows", String(PAGE));
      url.searchParams.set("type", "json");
      return url;
    }, PAGE, "신호등");
    return lightFeatures(rows);
  },
};

const code = (v: unknown) => String(v ?? "").trim().replace(/^0+/, "");
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A light's night flashing as "HH:MM-HH:MM", or none. A window longer than
 * MAX_NIGHT_H is not a night ("00:00-23:59" is written for 864 lights,
 * which would be a warning all day): better unsaid than said wrongly.
 */
const MAX_NIGHT_H = 16;
export function nightHours(on: unknown, open: string, close: string): string | undefined {
  if (on !== "Y" || !HHMM.test(open) || !HHMM.test(close) || open === close) return undefined;
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const span = (minutes(close) - minutes(open) + 1440) % 1440;
  return span > MAX_NIGHT_H * 60 ? undefined : `${open}-${close}`;
}

export function lightFeatures(rows: Row[]): Feature[] {
  const out: Feature[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const kind = code(r.tfclghtSe);
    if (kind !== "1" && kind !== "6") continue;
    // Seoul's own list (SEOUL_LIGHTS) has every light there; this one's are kept only for their night hours.
    const flashHours = kind === "6" ? "always" : nightHours(r.opratnYn, String(r.flashingLightOpenHhmm ?? ""), String(r.flashingLightCloseHhmm ?? ""));
    if (String(r.ctprvnNm ?? "").startsWith("서울") && !flashHours) continue;
    const lat = num(r.latitude), lon = num(r.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !lat || !lon) continue;
    // Several lamps hang at one corner; one a few metres is one light to a driver.
    const spot = `${lon.toFixed(4)},${lat.toFixed(4)}`;
    const id = `light:${r.tfclghtManageNo ?? spot}`;
    if (seen.has(id) || seen.has(spot)) continue;
    seen.add(id);
    seen.add(spot);
    const flash = flashHours;
    out.push({
      id, kind: "signal-light", lon, lat,
      name: String(r.roadRouteNm ?? "") || undefined,
      detail: String(r.sgnaspOrdr ?? "") || undefined,
      flash,
    });
  }
  return out;
}

/**
 * 서울 열린데이터광장 교통안전시설물 부착대 (trafficSafetyA057PInfo, its own
 * key): every signal head in Seoul, daily, in EPSG:5186. Kept are the
 * vehicle lamps (신호등종류 002 3색등, 003 4색등, 005 · 006 종형) — not the
 * walk signals (007), bicycle, bus-lane or warning lamps. No night hours
 * are given, so these are for the map only.
 */
const TM_5186 = "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs";
const VEHICLE_LAMPS = new Set(["002", "003", "005", "006"]);
export const SEOUL_LIGHTS: Dataset = {
  name: "seoul-lights",
  label: "서울 신호등",
  keyName: "seoulKey",
  async fetch(key) {
    const PAGE = 1000;
    const url = (from: number) => `http://openapi.seoul.go.kr:8088/${encodeURIComponent(key)}/json/trafficSafetyA057PInfo/${from}/${from + PAGE - 1}/`;
    const page = async (from: number): Promise<{ rows: Row[]; total: number }> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const answer = await fetch(url(from), { signal: AbortSignal.timeout(60_000) });
          const body = (await answer.json()) as { trafficSafetyA057PInfo?: { list_total_count?: number; row?: Row[] }; RESULT?: { CODE?: string; MESSAGE?: string } };
          const set = body.trafficSafetyA057PInfo;
          if (!set) throw new Error(`서울 신호등: ${body.RESULT?.CODE ?? answer.status} ${body.RESULT?.MESSAGE ?? ""}`);
          return { rows: set.row ?? [], total: Number(set.list_total_count ?? 0) };
        } catch (e) {
          if (attempt >= 2) throw e;
          await new Promise((done) => setTimeout(done, 2000 * (attempt + 1)));
        }
      }
    };
    const first = await page(1);
    const rows = [...first.rows];
    for (let from = PAGE + 1; from <= first.total; from += PAGE * 6) {
      const batch = await Promise.all(Array.from({ length: 6 }, (_, i) => from + i * PAGE).filter((f) => f <= first.total).map(page));
      for (const b of batch) for (const r of b.rows) rows.push(r);
    }
    return seoulLightFeatures(rows);
  },
};

export function seoulLightFeatures(rows: Row[]): Feature[] {
  const toWgs = proj4(TM_5186, "EPSG:4326");
  const out: Feature[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!VEHICLE_LAMPS.has(String(r.TRFC_LGHT_KND ?? "").trim())) continue;
    const x = num(r.XCRD), y = num(r.YCRD);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !x || !y) continue;
    const [lon, lat] = toWgs.forward([x, y]);
    const spot = `${lon.toFixed(4)},${lat.toFixed(4)}`;
    if (seen.has(spot)) continue;
    seen.add(spot);
    out.push({ id: `seoul-light:${r.ATCH_MNG_NO1 ?? spot}`, kind: "signal-light", lon, lat });
  }
  return out;
}

/**
 * 전국노인장애인보호구역표준데이터 (its own 활용신청, the data.go.kr key): the
 * same standard's shape as the school zones', each kept as its facility's
 * point and made a stretch of the route beside it by the page.
 */
export const SENIOR_ZONES: Dataset = {
  name: "senior-zones",
  label: "노인 보호구역",
  async fetch(key) {
    const PAGE = 1000;
    const rows = await allPages((p) => {
      const url = new URL("https://api.data.go.kr/openapi/tn_pubr_public_oldnddspsnprt_carea_api");
      url.searchParams.set("serviceKey", serviceKey(key));
      url.searchParams.set("pageNo", String(p));
      url.searchParams.set("numOfRows", String(PAGE));
      url.searchParams.set("type", "json");
      return url;
    }, PAGE, "노인 보호구역");
    return seniorZoneFeatures(rows);
  },
};

/** Each row gives its own limit (lmttVe, 30 mostly); the facility's kind the list does not say plainly. */
export function seniorZoneFeatures(rows: Row[]): Feature[] {
  const limitOf = (r: Row) => { const v = num(r.lmttVe); return v > 0 ? v : undefined; };
  return schoolZoneFeatures(rows, limitOf).map((f) => ({ ...f, id: f.id.replace(/^school-zone:/, "senior-zone:"), kind: "senior-zone" as const, detail: "노인 · 장애인 보호구역" }));
}
