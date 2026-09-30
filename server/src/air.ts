import type { LonLat } from "./route/types.js";
import { Cache } from "./nearby/util.js";
import type { RegionNames } from "./nearby/kakao.js";

/**
 * 미세먼지 where the car is, from 한국환경공단 에어코리아 (대기오염정보, the
 * data.go.kr key). Its stations are asked by 시도, and the one for the car
 * is found by name: a station is named for its 동 or its 구 (강남구,
 * 반포동, 도산대로 …). Where none matches, the province's middle value
 * stands in. The 측정소정보 service would give the nearest by distance, but
 * it is a separate 활용신청 and the name is close enough for a grade.
 */
export type Grade = 1 | 2 | 3 | 4;
export const GRADE_WORDS: Record<Grade, string> = { 1: "좋음", 2: "보통", 3: "나쁨", 4: "매우 나쁨" };

export interface Air {
  station: string;
  /** µg/m³ */
  pm10?: number;
  pm25?: number;
  pm10Grade?: Grade;
  pm25Grade?: Grade;
  /** "2026-09-29 23:00" */
  time?: string;
  /** True when no station matched and this is the province's middle. */
  province?: boolean;
}

type Row = Record<string, string | null | undefined>;

/** 에어코리아's sidoName for a 시도 as Kakao spells it; a merged one reads as both. */
export function sidoNames(sido: string): string[] {
  const s = sido.replace(/\s+/g, "");
  const out: string[] = [];
  const pairs: [RegExp, string][] = [
    [/^서울/, "서울"], [/^부산/, "부산"], [/^대구/, "대구"], [/^인천/, "인천"], [/광주/, "광주"], [/^대전/, "대전"], [/^울산/, "울산"],
    [/^세종/, "세종"], [/^경기/, "경기"], [/^강원/, "강원"], [/^(충청북|충북)/, "충북"], [/^(충청남|충남)/, "충남"],
    [/^(전라북|전북)/, "전북"], [/^(전라남|전남)/, "전남"], [/^(경상북|경북)/, "경북"], [/^(경상남|경남)/, "경남"], [/^제주/, "제주"],
  ];
  for (const [re, name] of pairs) if (re.test(s) && !out.includes(name)) out.push(name);
  return out;
}

/** The standard's breakpoints, for a row that gives the value but not the grade. */
export function gradeOf(kind: "pm10" | "pm25", v: number): Grade {
  const [a, b, c] = kind === "pm10" ? [30, 80, 150] : [15, 35, 75];
  return v <= a ? 1 : v <= b ? 2 : v <= c ? 3 : 4;
}

export class AirKorea {
  private bySido = new Cache<Row[]>(20 * 60_000, 30);

  constructor(private key: () => string | undefined, private regionOf: (at: LonLat) => Promise<RegionNames | null>) {}
  get ready() {
    return !!this.key();
  }

  async at(at: LonLat): Promise<Air | null> {
    const region = await this.regionOf(at);
    if (!region) return null;
    const rows = (await Promise.all(sidoNames(region.sido).map((s) => this.sido(s)))).flat();
    return pickStation(rows, region);
  }

  private sido(name: string): Promise<Row[]> {
    return this.bySido.get(name, async () => {
      const url = new URL("https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty");
      url.searchParams.set("serviceKey", decodeURIComponent(this.key()!));
      url.searchParams.set("sidoName", name);
      url.searchParams.set("returnType", "json");
      url.searchParams.set("numOfRows", "200");
      url.searchParams.set("pageNo", "1");
      url.searchParams.set("ver", "1.3");
      const answer = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const text = await answer.text();
      let body: { response?: { header?: { resultCode?: string; resultMsg?: string }; body?: { items?: Row[] } } };
      try { body = JSON.parse(text); } catch { throw new Error(`air: ${answer.status} ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}`); }
      const code = body.response?.header?.resultCode;
      if (code && code !== "00") throw new Error(`air: ${code} ${body.response?.header?.resultMsg ?? ""}`);
      return body.response?.body?.items ?? [];
    });
  }
}

const value = (v: unknown) => {
  const n = Number(v);
  return v == null || v === "" || v === "-" || !Number.isFinite(n) ? undefined : n;
};
const grade = (v: unknown): Grade | undefined => {
  const n = Number(v);
  return n >= 1 && n <= 4 ? (n as Grade) : undefined;
};

/** The station named for the car's 동, else its 구·시·군, else the province's middle. */
export function pickStation(rows: Row[], region: RegionNames): Air | null {
  const live = rows.filter((r) => value(r.pm10Value) != null || value(r.pm25Value) != null);
  if (live.length === 0) return null;
  const named = (name: string) => live.find((r) => r.stationName === name);
  const parts = region.sigungu.split(/\s+/).filter(Boolean);
  const bare = (w: string) => w.replace(/(시|군|구)$/, "");
  const hit =
    region.dongs.map(named).find(Boolean) ??
    [...parts].reverse().map(named).find(Boolean) ??
    live.find((r) => parts.some((p) => bare(p).length >= 2 && (r.stationName ?? "").startsWith(bare(p))));
  if (hit) return airOf(hit, String(hit.stationName));
  // The middle of the province, value by value.
  const mid = (key: string) => {
    const vs = live.map((r) => value(r[key])).filter((v): v is number => v != null).sort((a, b) => a - b);
    return vs.length ? vs[Math.floor(vs.length / 2)] : undefined;
  };
  const pm10 = mid("pm10Value"), pm25 = mid("pm25Value");
  return {
    station: region.sido,
    pm10, pm25,
    pm10Grade: pm10 != null ? gradeOf("pm10", pm10) : undefined,
    pm25Grade: pm25 != null ? gradeOf("pm25", pm25) : undefined,
    time: live[0].dataTime ?? undefined,
    province: true,
  };
}

function airOf(r: Row, station: string): Air {
  const pm10 = value(r.pm10Value), pm25 = value(r.pm25Value);
  return {
    station,
    pm10, pm25,
    // 1-hour grades where given (what the car apps show), else the 24-hour ones, else from the value.
    pm10Grade: grade(r.pm10Grade1h) ?? grade(r.pm10Grade) ?? (pm10 != null ? gradeOf("pm10", pm10) : undefined),
    pm25Grade: grade(r.pm25Grade1h) ?? grade(r.pm25Grade) ?? (pm25 != null ? gradeOf("pm25", pm25) : undefined),
    time: r.dataTime ?? undefined,
  };
}
