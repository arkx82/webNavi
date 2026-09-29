import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { featuresOf, type Feature } from "./index.js";

/**
 * Every enforcement camera in the country, from 경찰청's standard data
 * through data.go.kr's API (전국무인교통단속카메라표준데이터 — the same
 * data.go.kr key as the chargers, with its own 활용신청). No CSV to drop in
 * by hand: the server asks once, keeps the answer beside its settings, and
 * asks again when it is a week old.
 */
const URL_BASE = "https://api.data.go.kr/openapi/tn_pubr_public_unmanned_traffic_camera_api";
const PAGE = 1000;
const MAX_PAGES = 200;
export const CAMERAS_MAX_AGE_MS = 7 * 86_400_000;

/** The API's English field names onto the CSV's Korean ones, which the parser reads. */
const FIELDS: Record<string, string> = {
  mnlssRegltCameraManageNo: "무인교통단속카메라관리번호",
  latitude: "위도",
  longitude: "경도",
  regltSe: "단속구분",
  lmttVe: "제한속도",
  prtcareaType: "보호구역구분",
  roadRouteDrc: "도로노선방향",
  roadRouteNm: "도로노선명",
  regltSctnLcSe: "단속구간위치구분",
  itlpc: "설치장소",
};

export function korean(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) out[FIELDS[k] ?? k] = v == null ? "" : String(v);
  // Each agency numbers its own cameras from 1: the number alone repeats across the country.
  if (row.insttCode && row.mnlssRegltCameraManageNo) out["무인교통단속카메라관리번호"] = `${row.insttCode}-${row.mnlssRegltCameraManageNo}`;
  return out;
}

type Page = { header?: { resultCode?: string; resultMsg?: string }; body?: { items?: unknown; totalCount?: string | number } };

export interface KeptCameras {
  at: number;
  features: Feature[];
}

export function keptCameras(dir: string): KeptCameras | null {
  const file = join(dir, "cameras.json");
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as KeptCameras; } catch { return null; }
}

export async function fetchCameras(key: string, dir: string): Promise<KeptCameras> {
  const rows: Record<string, string>[] = [];
  let total = Infinity;
  for (let page = 1; page <= MAX_PAGES && rows.length < total; page++) {
    const url = new URL(URL_BASE);
    url.searchParams.set("serviceKey", decodeURIComponent(key));
    url.searchParams.set("pageNo", String(page));
    url.searchParams.set("numOfRows", String(PAGE));
    url.searchParams.set("type", "json");
    const answer = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const text = await answer.text();
    let raw: Page & { response?: Page; OpenAPI_ServiceResponse?: { cmmMsgHeader?: { errMsg?: string; returnAuthMsg?: string } } };
    try { raw = JSON.parse(text); } catch { throw new Error(`cameras: ${answer.status} ${text.replace(/\s+/g, " ").slice(0, 200)}`); }
    // The gateway's own refusal (a key not yet allowed this dataset) has another shape altogether.
    const refused = raw.OpenAPI_ServiceResponse?.cmmMsgHeader;
    if (refused) throw new Error(`cameras: ${refused.returnAuthMsg ?? refused.errMsg} — data.go.kr 전국무인교통단속카메라표준데이터 오픈API 활용신청 필요`);
    // Answers come wrapped in "response" or not, by the gateway's mood.
    const body = { response: raw.response ?? raw };
    if (!body.response.header && !body.response.body) throw new Error(`cameras: ${answer.status} unexpected answer ${text.slice(0, 120)}`);
    const header = body.response?.header;
    if (header?.resultCode && header.resultCode !== "00") {
      if (header.resultCode === "03") break; // no more data
      throw new Error(`cameras: ${header.resultCode} ${header.resultMsg ?? ""}`);
    }
    total = Number(body.response?.body?.totalCount ?? Infinity);
    const items = body.response?.body?.items;
    const list = (Array.isArray(items) ? items : (items as { item?: unknown })?.item) as Record<string, unknown>[] | Record<string, unknown> | undefined;
    const got = list == null ? [] : Array.isArray(list) ? list : [list];
    if (got.length === 0) break;
    rows.push(...got.map(korean));
  }
  const features = featuresOf(rows, "police-api");
  // An empty list is a failure to say so, not a week's answer to keep.
  if (features.length === 0) throw new Error("cameras: the API answered no cameras");
  const kept: KeptCameras = { at: Date.now(), features };
  writeFileSync(join(dir, "cameras.json"), JSON.stringify(kept));
  return kept;
}
