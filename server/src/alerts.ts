import type { LonLat } from "./route/types.js";
import { Cache } from "./nearby/util.js";
import type { RegionNames } from "./nearby/kakao.js";
import { sidoNames } from "./air.js";

/**
 * 기상특보 in force where the car is (기상청 기상특보 조회서비스, the
 * data.go.kr key). 기상청 publishes the whole country's state as text —
 * "o 호우경보 : 서울, 경기도(고양, 파주)" a line — so it is asked once for
 * everyone and read against the car's 시도 and 시군구 by name.
 */
export interface Alert {
  /** 호우, 대설, 태풍, 강풍, 한파, 폭염, 황사, 건조, 풍랑 … */
  kind: string;
  level: "주의보" | "경보";
  /** "here": the car's own city is named (or its whole province); "part": a zone of its province (산지, 북부 …) that may be it. */
  where: "here" | "part";
  /** The area as 기상청 wrote it, for the screen. */
  area: string;
}
export interface Alerts {
  alerts: Alert[];
  /** When 기상청 issued this state, "202609290800". */
  issued?: string;
}

export interface Warning {
  kind: string;
  level: "주의보" | "경보";
  areas: string[];
}

/** The t6 text into warnings, each with its areas split at the top-level commas. */
export function parseStatus(t6: string): Warning[] {
  const out: Warning[] = [];
  for (const raw of t6.split(/\r?\n/)) {
    const m = raw.trim().match(/^o\s*(\S+?)(주의보|경보)\s*:\s*(.+)$/);
    if (!m) continue;
    out.push({ kind: m[1], level: m[2] as Warning["level"], areas: splitTop(m[3]) });
  }
  return out;
}

function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Words that name a zone of a province rather than a city in it. */
const ZONE = /권|산지|평지|북부|남부|동부|서부|중부|내륙|해안|지역|남서|북서|남동|북동/;

/** Whether [area] ("경기도(고양, 파주)", "서울", "강원도(강원북부산지)") covers the car's region. */
export function covers(area: string, region: RegionNames): Alert["where"] | null {
  const m = area.match(/^([^(]+)(?:\((.*)\))?$/);
  if (!m) return null;
  const head = m[1].trim();
  const mine = sidoNames(region.sido);
  const theirs = sidoNames(head);
  if (!theirs.length || !theirs.some((t) => mine.includes(t))) return null;
  if (!m[2]) return "here";
  const subs = m[2].split(/[,·]/).map((s) => s.trim()).filter(Boolean);
  const city = region.sigungu.split(/\s+/)[0]?.replace(/(시|군|구)$/, "") ?? "";
  if (city.length >= 1 && subs.some((s) => s.includes(city))) return "here";
  if (subs.some((s) => ZONE.test(s))) return "part";
  return null;
}

export function alertsFor(warnings: Warning[], region: RegionNames): Alert[] {
  const out: Alert[] = [];
  for (const w of warnings) {
    let best: Alert | null = null;
    for (const area of w.areas) {
      const where = covers(area, region);
      if (!where) continue;
      if (!best || (where === "here" && best.where === "part")) best = { kind: w.kind, level: w.level, where, area };
    }
    if (best) out.push(best);
  }
  // 경보 before 주의보, the sure before the maybe.
  return out.sort((a, b) => (a.level === b.level ? (a.where === b.where ? 0 : a.where === "here" ? -1 : 1) : a.level === "경보" ? -1 : 1));
}

export class KmaAlerts {
  private status = new Cache<{ warnings: Warning[]; issued?: string }>(10 * 60_000, 1);

  constructor(private key: () => string | undefined, private regionOf: (at: LonLat) => Promise<RegionNames | null>) {}
  get ready() {
    return !!this.key();
  }

  async at(at: LonLat): Promise<Alerts> {
    const [state, region] = await Promise.all([this.now(), this.regionOf(at)]);
    return { alerts: region ? alertsFor(state.warnings, region) : [], issued: state.issued };
  }

  now(): Promise<{ warnings: Warning[]; issued?: string }> {
    return this.status.get("now", async () => {
      const url = new URL("https://apis.data.go.kr/1360000/WthrWrnInfoService/getPwnStatus");
      url.searchParams.set("serviceKey", decodeURIComponent(this.key()!));
      url.searchParams.set("pageNo", "1");
      url.searchParams.set("numOfRows", "10");
      url.searchParams.set("dataType", "JSON");
      const answer = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const text = await answer.text();
      let body: { response?: { header?: { resultCode?: string; resultMsg?: string }; body?: { items?: { item?: { t6?: string; tmFc?: string | number }[] } } } };
      try { body = JSON.parse(text); } catch { throw new Error(`alerts: ${answer.status} ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}`); }
      const code = body.response?.header?.resultCode;
      if (code === "03") return { warnings: [] };
      if (code && code !== "00") throw new Error(`alerts: ${code} ${body.response?.header?.resultMsg ?? ""}`);
      const item = body.response?.body?.items?.item?.[0];
      return { warnings: parseStatus(item?.t6 ?? ""), issued: item?.tmFc != null ? String(item.tmFc) : undefined };
    });
  }
}
