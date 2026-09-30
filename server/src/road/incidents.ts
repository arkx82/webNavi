import type { LonLat } from "../route/types.js";
import { Cache, metresBetween } from "../nearby/util.js";
import type { Feature, Kind } from "../safety/index.js";

/**
 * ITS 국가교통정보센터's 돌발상황 — crashes, roadworks, breakdowns and
 * debris, on motorways and national roads (its.go.kr, its own key). The
 * whole country is a couple of hundred at a time, so it is asked whole
 * every few minutes and searched here.
 */
const URL_ALL = "https://openapi.its.go.kr:9443/eventInfo";
const TTL_MS = 3 * 60_000;

interface Event {
  type?: string;
  eventType?: string;
  eventDetailType?: string;
  startDate?: string;
  coordX?: string;
  coordY?: string;
  linkId?: string;
  roadName?: string;
  lanesBlocked?: string;
  message?: string;
}

export class Incidents {
  private all = new Cache<Feature[]>(TTL_MS, 1);

  constructor(private key: () => string | undefined) {}
  get ready() {
    return !!this.key();
  }

  async near(at: LonLat, radiusM: number): Promise<(Feature & { distanceM: number })[]> {
    const list = await this.everything();
    return list
      .map((f) => ({ ...f, distanceM: Math.round(metresBetween(at, [f.lon, f.lat])) }))
      .filter((f) => f.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM);
  }

  everything(): Promise<Feature[]> {
    return this.all.get("all", async () => {
      const url = new URL(URL_ALL);
      url.searchParams.set("apiKey", this.key()!);
      url.searchParams.set("type", "all");
      url.searchParams.set("eventType", "all");
      url.searchParams.set("minX", "124");
      url.searchParams.set("maxX", "132");
      url.searchParams.set("minY", "33");
      url.searchParams.set("maxY", "39");
      url.searchParams.set("getType", "json");
      const answer = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const text = await answer.text();
      let body: { header?: { resultCode?: number | string; resultMsg?: string }; body?: { items?: Event[] } };
      try { body = JSON.parse(text); } catch { throw new Error(`its: ${answer.status} ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}`); }
      const code = String(body.header?.resultCode ?? "0");
      if (code !== "0" && code !== "00") throw new Error(`its: ${code} ${body.header?.resultMsg ?? ""}`);
      return incidentFeatures(body.body?.items ?? []);
    });
  }
}

/** What an event is to a driver; null for what is not on the road (a promotion). */
export function incidentKind(e: Pick<Event, "eventType" | "eventDetailType">): Kind | null {
  const t = e.eventType ?? "";
  if (/사고/.test(t)) return "incident-crash";
  if (/공사/.test(t)) return "incident-work";
  if (t === "기타" && /이벤트|홍보|행사/.test(e.eventDetailType ?? "")) return null;
  return "incident-other";
}

export function incidentFeatures(events: Event[]): Feature[] {
  const out: Feature[] = [];
  for (const e of events) {
    const kind = incidentKind(e);
    const lon = Number(e.coordX), lat = Number(e.coordY);
    if (!kind || !Number.isFinite(lon) || !Number.isFinite(lat) || !lon || !lat) continue;
    const what = [e.eventDetailType || e.eventType, e.lanesBlocked].filter(Boolean).join(" · ");
    out.push({
      id: `its:${e.linkId ?? ""}:${e.startDate ?? ""}:${e.eventType ?? ""}`,
      kind,
      lon, lat,
      name: cleanMessage(e.message ?? "") || e.eventType,
      detail: [e.roadName, what].filter(Boolean).join(" · ") || undefined,
    });
  }
  return out;
}

/**
 * Some centres send the message as fields joined by "::" — "<공사>::성산로::
 * 금화터널북측::…::[공사] 금화터널 점검 / 장소: … / 2차로 부분통제::유지보수 서울청" —
 * of which the bracketed sentence is the one a driver reads.
 */
export function cleanMessage(message: string): string {
  const text = message.trim();
  if (!text.includes("::")) return text;
  const parts = text.split("::").map((p) => p.trim()).filter(Boolean);
  const said = parts.find((p) => /^\[[^\]]+\]/.test(p)) ?? parts.filter((p) => !/^<[^>]+>$/.test(p)).slice(0, 3).join(" ");
  return said.replace(/^\[[^\]]+\]\s*/, "").split(/\s*\/\s*장소\s*:/)[0].trim();
}
