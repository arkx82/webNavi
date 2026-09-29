import type { LonLat } from "./route/types.js";
import { Cache, metresBetween } from "./nearby/util.js";

/**
 * The weather where the car is, from 기상청 through data.go.kr (the same
 * key; 단기예보 and 중기예보 조회서비스, each its own 활용신청):
 * now (초단기실황), the next hours and days (단기예보), and on to ten days
 * (중기예보). Put into one plain shape so the page need not know KMA's
 * category codes.
 */
export type Sky = "clear" | "partly" | "cloudy" | "rain" | "sleet" | "snow" | "shower";

export interface Hour { t: string; temp?: number; sky: Sky; pop?: number }
export interface Day { date: string; min?: number; max?: number; am: Sky; pm: Sky; pop?: number }
export interface Weather {
  place: string;
  now: { temp?: number; sky: Sky; rain1h?: number; humidity?: number; windMs?: number } | null;
  hours: Hour[];
  days: Day[];
}

// ---- 기상청's grid: Lambert conformal conic, 5 km cells ----

/** lat/lon → the forecast grid's nx, ny (KMA's published DFS conversion). */
export function grid(lat: number, lon: number): { nx: number; ny: number } {
  const RE = 6371.00877 / 5.0, SLAT1 = 30, SLAT2 = 60, OLON = 126, OLAT = 38, XO = 43, YO = 136;
  const D = Math.PI / 180;
  const s1 = SLAT1 * D, s2 = SLAT2 * D, olon = OLON * D, olat = OLAT * D;
  let sn = Math.tan(Math.PI * 0.25 + s2 * 0.5) / Math.tan(Math.PI * 0.25 + s1 * 0.5);
  sn = Math.log(Math.cos(s1) / Math.cos(s2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + s1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(s1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (RE * sf) / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * D * 0.5);
  ra = (RE * sf) / Math.pow(ra, sn);
  let theta = lon * D - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5) };
}

// ---- time, in Korea ----

/** Now in KST as parts; the server's own zone does not matter. */
function kst(ms = Date.now()) {
  const d = new Date(ms + 9 * 3600_000);
  return { ymd: d.toISOString().slice(0, 10).replace(/-/g, ""), h: d.getUTCHours(), m: d.getUTCMinutes(), date: d };
}

/** The latest 초단기실황 hour: each is out some forty minutes past. */
export function ncstBase(ms = Date.now()): { date: string; time: string } {
  const t = kst(ms - 45 * 60_000);
  return { date: t.ymd, time: `${String(t.h).padStart(2, "0")}00` };
}

/** The latest 단기예보 run (02, 05 … 23 h), out about ten minutes after. */
export function vilageBase(ms = Date.now()): { date: string; time: string } {
  const runs = [2, 5, 8, 11, 14, 17, 20, 23];
  const t = kst(ms - 15 * 60_000);
  const h = [...runs].reverse().find((r) => r <= t.h);
  if (h != null) return { date: t.ymd, time: `${String(h).padStart(2, "0")}00` };
  return { date: kst(ms - 24 * 3600_000).ymd, time: "2300" };
}

/** The latest 중기예보 (06 h or 18 h). */
export function midBase(ms = Date.now()): string {
  const t = kst(ms - 20 * 60_000);
  if (t.h >= 18) return `${t.ymd}1800`;
  if (t.h >= 6) return `${t.ymd}0600`;
  return `${kst(ms - 24 * 3600_000).ymd}1800`;
}

// ---- words and codes into one sky ----

/** SKY (1 맑음, 3 구름많음, 4 흐림) and PTY (0 none, 1 비, 2 비/눈, 3 눈, 4 소나기, 5 빗방울, 6 빗방울눈날림, 7 눈날림). */
export function skyOf(sky?: string, pty?: string): Sky {
  switch (pty) {
    case "1": case "5": return "rain";
    case "2": case "6": return "sleet";
    case "3": case "7": return "snow";
    case "4": return "shower";
  }
  return sky === "1" ? "clear" : sky === "3" ? "partly" : sky === "4" ? "cloudy" : "clear";
}

/** 중기예보's words: "흐리고 비", "구름많고 눈/비", "맑음" … */
export function skyOfWords(w?: string): Sky {
  if (!w) return "cloudy";
  if (/비\/눈|눈\/비/.test(w)) return "sleet";
  if (/소나기/.test(w)) return "shower";
  if (/눈/.test(w)) return "snow";
  if (/비/.test(w)) return "rain";
  if (/흐림|흐리/.test(w)) return "cloudy";
  if (/구름/.test(w)) return "partly";
  return "clear";
}

const WORSE: Sky[] = ["clear", "partly", "cloudy", "shower", "rain", "sleet", "snow"];
const worst = (a: Sky, b: Sky) => (WORSE.indexOf(b) > WORSE.indexOf(a) ? b : a);

// ---- 중기예보 areas: the nearest city's temperatures, its province's words ----

const CITIES: { name: string; at: LonLat; land: string; ta: string }[] = [
  { name: "서울", at: [126.978, 37.5665], land: "11B00000", ta: "11B10101" },
  { name: "인천", at: [126.7052, 37.4563], land: "11B00000", ta: "11B20201" },
  { name: "수원", at: [127.0286, 37.2636], land: "11B00000", ta: "11B20601" },
  { name: "춘천", at: [127.7298, 37.8813], land: "11D10000", ta: "11D10301" },
  { name: "원주", at: [127.9202, 37.3422], land: "11D10000", ta: "11D10401" },
  { name: "강릉", at: [128.8761, 37.7519], land: "11D20000", ta: "11D20501" },
  { name: "대전", at: [127.3845, 36.3504], land: "11C20000", ta: "11C20401" },
  { name: "세종", at: [127.289, 36.48], land: "11C20000", ta: "11C20404" },
  { name: "청주", at: [127.489, 36.6424], land: "11C10000", ta: "11C10301" },
  { name: "전주", at: [127.148, 35.8242], land: "11F10000", ta: "11F10201" },
  { name: "광주", at: [126.8526, 35.1595], land: "11F20000", ta: "11F20501" },
  { name: "목포", at: [126.3922, 34.8118], land: "11F20000", ta: "21F20801" },
  { name: "여수", at: [127.6622, 34.7604], land: "11F20000", ta: "11F20401" },
  { name: "대구", at: [128.6014, 35.8714], land: "11H10000", ta: "11H10701" },
  { name: "안동", at: [128.7294, 36.5684], land: "11H10000", ta: "11H10501" },
  { name: "포항", at: [129.3435, 36.019], land: "11H10000", ta: "11H10201" },
  { name: "부산", at: [129.0756, 35.1796], land: "11H20000", ta: "11H20201" },
  { name: "울산", at: [129.3114, 35.5384], land: "11H20000", ta: "11H20101" },
  { name: "창원", at: [128.6811, 35.2285], land: "11H20000", ta: "11H20301" },
  { name: "제주", at: [126.5312, 33.4996], land: "11G00000", ta: "11G00201" },
];

export function nearestCity(at: LonLat) {
  return CITIES.reduce((a, b) => (metresBetween(at, b.at) < metresBetween(at, a.at) ? b : a));
}

// ---- the calls ----

type Item = Record<string, string | number>;

export class KmaWeather {
  private ncst = new Cache<Item[]>(10 * 60_000, 100);
  private vilage = new Cache<Item[]>(30 * 60_000, 100);
  private mid = new Cache<{ land: Item | null; ta: Item | null; base: string }>(3 * 3600_000, 50);

  constructor(private key: () => string | undefined) {}
  get ready() {
    return !!this.key();
  }

  async at(at: LonLat): Promise<Weather> {
    const { nx, ny } = grid(at[1], at[0]);
    const city = nearestCity(at);
    const [now, fcst, mid] = await Promise.all([
      this.ncst.get(`${nx},${ny}:${ncstBase().time}`, () => this.items("VilageFcstInfoService_2.0/getUltraSrtNcst", { ...base(ncstBase()), nx, ny, numOfRows: 20 })).catch(() => [] as Item[]),
      this.vilage.get(`${nx},${ny}:${vilageBase().date}${vilageBase().time}`, () => this.items("VilageFcstInfoService_2.0/getVilageFcst", { ...base(vilageBase()), nx, ny, numOfRows: 1500 })).catch(() => [] as Item[]),
      this.mid.get(`${city.ta}:${midBase()}`, async () => {
        const tmFc = midBase();
        const [land, ta] = await Promise.all([
          this.items("MidFcstInfoService/getMidLandFcst", { regId: city.land, tmFc }).then((i) => i[0] ?? null).catch(() => null),
          this.items("MidFcstInfoService/getMidTa", { regId: city.ta, tmFc }).then((i) => i[0] ?? null).catch(() => null),
        ]);
        return { land, ta, base: tmFc };
      }),
    ]);
    return assemble(city.name, now, fcst, mid);
  }

  private async items(path: string, params: Record<string, string | number>): Promise<Item[]> {
    const url = new URL(`https://apis.data.go.kr/1360000/${path}`);
    url.searchParams.set("serviceKey", decodeURIComponent(this.key()!));
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("dataType", "JSON");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    if (!url.searchParams.has("numOfRows")) url.searchParams.set("numOfRows", "10");
    const answer = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const text = await answer.text();
    let body: { response?: { header?: { resultCode?: string; resultMsg?: string }; body?: { items?: { item?: Item[] } } } };
    try { body = JSON.parse(text); } catch { throw new Error(`kma: ${answer.status} ${text.replace(/<[^>]+>/g, " ").trim().slice(0, 160)}`); }
    const code = body.response?.header?.resultCode;
    if (code && code !== "00") throw new Error(`kma: ${code} ${body.response?.header?.resultMsg ?? ""}`);
    return body.response?.body?.items?.item ?? [];
  }
}

function base(b: { date: string; time: string }) {
  return { base_date: b.date, base_time: b.time };
}

/** KMA's rows into the page's shape: now, the next 24 hours, and a day a line for ten days. */
export function assemble(place: string, now: Item[], fcst: Item[], mid: { land: Item | null; ta: Item | null; base: string }, nowMs = Date.now()): Weather {
  const obs = (c: string) => now.find((i) => i.category === c)?.obsrValue as string | undefined;
  const num = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
  const out: Weather = {
    place,
    now: now.length ? { temp: num(obs("T1H")), sky: skyOf("1", obs("PTY")), rain1h: num(obs("RN1")), humidity: num(obs("REH")), windMs: num(obs("WSD")) } : null,
    hours: [],
    days: [],
  };
  // By forecast hour: the categories for each.
  const slots = new Map<string, Record<string, string>>();
  for (const i of fcst) {
    const k = `${i.fcstDate}${i.fcstTime}`;
    const slot = slots.get(k) ?? {};
    slot[String(i.category)] = String(i.fcstValue);
    slots.set(k, slot);
  }
  const keys = [...slots.keys()].sort();
  const k = kst(nowMs);
  const nowKey = `${k.ymd}${String(k.h).padStart(2, "0")}00`;
  for (const key of keys) {
    if (key < nowKey || out.hours.length >= 24) continue;
    const v = slots.get(key)!;
    out.hours.push({ t: `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T${key.slice(8, 10)}:00`, temp: num(v.TMP), sky: skyOf(v.SKY, v.PTY), pop: num(v.POP) });
  }
  // The now's sky, which 실황 does not give: the forecast for this hour.
  if (out.now) {
    const first = slots.get(keys.find((key) => key >= nowKey) ?? "");
    if (first) out.now.sky = skyOf(first.SKY, obs("PTY") && obs("PTY") !== "0" ? obs("PTY") : first.PTY);
  }
  // Days from the short-term forecast.
  const byDay = new Map<string, Day>();
  /** Hours the short-term forecast has for each day: its last day holds only its first few. */
  const hoursIn = new Map<string, number>();
  for (const key of keys) {
    const date = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
    const h = Number(key.slice(8, 10));
    const v = slots.get(key)!;
    const d = byDay.get(date) ?? { date, am: "clear", pm: "clear" };
    hoursIn.set(date, (hoursIn.get(date) ?? 0) + 1);
    const sky = skyOf(v.SKY, v.PTY);
    if (h >= 6 && h < 12) d.am = worst(d.am, sky);
    if (h >= 12 && h < 18) d.pm = worst(d.pm, sky);
    const t = num(v.TMP);
    if (t != null) { d.min = Math.min(d.min ?? t, t); d.max = Math.max(d.max ?? t, t); }
    if (num(v.TMN) != null) d.min = num(v.TMN);
    if (num(v.TMX) != null) d.max = num(v.TMX);
    const pop = num(v.POP);
    if (pop != null) d.pop = Math.max(d.pop ?? 0, pop);
    byDay.set(date, d);
  }
  // A day seen only in part (today's evening, say) keeps what it has.
  out.days = [...byDay.values()].filter((d) => d.date >= `${k.ymd.slice(0, 4)}-${k.ymd.slice(4, 6)}-${k.ymd.slice(6, 8)}`);
  // Then 중기예보: day N after its issue date, where the short-term has none.
  if (mid.land || mid.ta) {
    const issued = Date.UTC(Number(mid.base.slice(0, 4)), Number(mid.base.slice(4, 6)) - 1, Number(mid.base.slice(6, 8)));
    for (let n = 3; n <= 10; n++) {
      const date = new Date(issued + n * 86_400_000).toISOString().slice(0, 10);
      // A whole day from the short-term forecast stands; a scrap of one gives way to this.
      if (byDay.has(date) && (hoursIn.get(date) ?? 0) >= 12) continue;
      const land = mid.land ?? {}, ta = mid.ta ?? {};
      const am = land[`wf${n}Am`] ?? land[`wf${n}`], pm = land[`wf${n}Pm`] ?? land[`wf${n}`];
      if (am == null && ta[`taMin${n}`] == null) continue;
      const pops = [land[`rnSt${n}Am`], land[`rnSt${n}Pm`], land[`rnSt${n}`]].map(num).filter((x): x is number => x != null);
      const day: Day = { date, min: num(ta[`taMin${n}`]), max: num(ta[`taMax${n}`]), am: skyOfWords(am as string), pm: skyOfWords(pm as string), pop: pops.length ? Math.max(...pops) : undefined };
      const i = out.days.findIndex((d) => d.date === date);
      if (i >= 0) out.days[i] = day; else out.days.push(day);
    }
  }
  out.days.sort((a, b) => a.date.localeCompare(b.date));
  out.days = out.days.slice(0, 10);
  return out;
}
