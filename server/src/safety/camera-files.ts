import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { decode, featuresOf, type Feature } from "./index.js";

/**
 * The cameras the national list leaves out, from the agencies' own files on data.go.kr. The national list
 * (cameras.ts) is 경찰청's half-yearly copy merged with what each agency gave it, some years old — and an agency's
 * own file can be newer: 충청남도's of 2026-09-14 had 189 speed and signal cameras with no camera of the national list
 * within 300 m (2026-10-27), school gates and junctions among them. So once a week the portal is searched for camera
 * files; a file in the standard data's columns (위도, 경도, 단속구분 …) is read as the national list is, and a camera
 * of it is taken only where the national list has none near (FILL_CLEAR_M): the gaps filled, nothing given twice.
 * Files in other shapes (an address and no position, parking cameras only) are listed for /admin, not read.
 */

const SEARCH = "https://www.data.go.kr/tcs/dss/selectDataSetList.do";
const KEYWORDS = ["무인단속카메라", "무인교통단속", "단속카메라", "교통카메라", "과속단속", "무인카메라"];
const MAX_PAGES = 8;
const SKIP_NAMES = /주정차|주차단속|방범|버스전용|쓰레기|불법투기|공해|웹카메라|관제|위반|연도별|운영\s*대수|단속\s*현황_|이동식|이동형/;
/** A file larger than this is not a camera list. */
const MAX_BYTES = 20 * 1024 * 1024;
export const FILES_MAX_AGE_MS = 7 * 86_400_000;
export const FILES_VERSION = 1;
/** A file's camera is a gap only with no camera of the national list (or one already taken) this near. */
export const FILL_CLEAR_M = 150;

export interface CameraFile {
  /** data.go.kr's number of the dataset. */
  id: string;
  name: string;
  /** The agency that gave it. */
  by: string;
  /** When the portal last had it changed, and the newest 데이터기준일자 in it. */
  modified: string;
  asOf?: string;
  /** The province most of its rows are in. */
  sido?: string;
  rows: number;
  /** Cameras a driver is warned of (speed, signal, section), read as the national list's are. */
  cameras: number;
  /** In the standard data's columns, with positions: read. Otherwise why not. */
  read: boolean;
  why?: string;
  url: string;
}

export interface KeptFiles {
  at: number;
  v: number;
  files: CameraFile[];
  /** Every camera of the files read; which of them fill a gap is decided against the national list (fillGaps). */
  features: Feature[];
}

export type Get = (url: string) => Promise<{ ok: boolean; status: number; bytes(): Promise<Buffer> }>;

const defaultGet: Get = async (url) => {
  const a = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (WebNavi)" }, signal: AbortSignal.timeout(30_000) });
  return { ok: a.ok, status: a.status, bytes: async () => Buffer.from(await a.arrayBuffer()) };
};

export function keptFiles(dir: string): KeptFiles | null {
  const file = join(dir, "camera-files.json");
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as KeptFiles; } catch { return null; }
}

/** The portal's datasets for [keyword], every page of them. */
async function searchIds(get: Get, keyword: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = new URLSearchParams({ dType: "FILE", keyword, perPage: "50", currentPage: String(page) });
    const a = await get(`${SEARCH}?${q}`);
    if (!a.ok) throw new Error(`data.go.kr 검색 ${a.status}`);
    const found = [...(await a.bytes()).toString("utf8").matchAll(/data\/(\d{8})\/fileData\.do/g)].map((m) => m[1]);
    const before = ids.size;
    for (const id of found) ids.add(id);
    if (ids.size === before) break;
  }
  return ids;
}

/** A dataset's file read into rows (header names as given), or why not. */
export function rowsOf(bytes: Buffer): Record<string, string>[] {
  return parse(decode(bytes), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true, relax_quotes: true }) as Record<string, string>[];
}

/** The first of [names] a row has a value under (header names are given with stray spaces). */
const pick = (row: Record<string, string>, names: RegExp) => {
  for (const [k, v] of Object.entries(row)) if (names.test(k.trim()) && (v ?? "").trim()) return v.trim();
  return "";
};

/**
 * A file in its own columns put into the standard data's: 하남시's "신호과속 단속 CCTV" (장치명, 설치방향정보명,
 * 제한속도), 미추홀구's 어린이보호구역 cameras (시설명, 단속방향, 설치목적 "신호·과속단속"). The kind is the row's
 * purpose, or the file's name where it names one; a row whose kind cannot be told is left out (what to say of it?).
 */
export function standardize(rows: Record<string, string>[], fileName: string): Record<string, string>[] {
  if (rows.length === 0 || "단속구분" in rows[0]) return rows;
  const school = /어린이|스쿨존/.test(fileName);
  return rows.map((r) => {
    const purpose = pick(r, /^(설치목적|용도|장비기능|단속유형|단속종류|구분)$/);
    const kind = /신호|과속|속도|구간/.test(purpose) ? purpose : /신호|과속/.test(fileName) ? fileName.replace(/.*?(신호\s*과속|과속|신호)/, "$1") : "";
    const place = pick(r, /^(설치장소|설치위치|설치위치명|시설명|장치명|위치)$/);
    const way = pick(r, /^(단속방향|설치방향정보명|촬영방면정보|방면|방향)$/);
    return {
      위도: pick(r, /^(위도|Y좌표\(위도\)|Y좌표)$/),
      경도: pick(r, /^(경도|X좌표\(경도\)|X좌표)$/),
      // An unknown kind as a code featuresOf reads as none.
      단속구분: kind || "0",
      제한속도: pick(r, /^(제한속도|제한 속도)$/),
      보호구역구분: school || pick(r, /^보호구역명$/) ? "어린이보호구역" : "",
      설치장소: way && !place.includes(way) ? `${place} (${way})` : place,
      데이터기준일자: pick(r, /기준일/),
      시도명: pick(r, /^시도명?$/),
      무인교통단속카메라관리번호: pick(r, /^(무인교통단속카메라관리번호|관리번호|장치아이디|카메라번호|연번|번호)$/),
    };
  });
}

/** What a file is worth to us: read (its cameras) or not, and why not. */
export function judge(raw: Record<string, string>[], source: string, fileName = ""): { read: boolean; why?: string; cameras: Feature[]; asOf?: string; sido?: string } {
  const rows = standardize(raw.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim(), v]))), fileName);
  const head = Object.keys(rows[0] ?? {});
  const asOf = rows.map((r) => (r["데이터기준일자"] ?? r["데이터 작성 기준일자"] ?? "").trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop();
  const sidoCount = new Map<string, number>();
  for (const r of rows) if (r["시도명"]) sidoCount.set(r["시도명"], (sidoCount.get(r["시도명"]) ?? 0) + 1);
  const sido = [...sidoCount].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!rows.some((r) => Number(r["위도"]) && Number(r["경도"]))) return { read: false, why: "좌표 없음 (주소만)", cameras: [], asOf, sido };
  const cameras = featuresOf(rows, source);
  if (cameras.length === 0) {
    const unknown = rows.every((r) => !r["단속구분"] || r["단속구분"] === "0");
    return { read: false, why: unknown ? "카메라 종류(과속·신호) 없음" : "과속·신호 카메라 없음 (주정차 등)", cameras, asOf, sido };
  }
  return { read: true, cameras, asOf, sido };
}

/**
 * The portal searched for camera files, each looked at and the standard ones read. A file the last search had at
 * the same date is not fetched again.
 */
export async function findCameraFiles(dir: string, log: (m: string) => void = () => {}, get: Get = defaultGet, before = keptFiles(dir)): Promise<KeptFiles> {
  const ids = new Set<string>();
  for (const k of KEYWORDS) for (const id of await searchIds(get, k)) ids.add(id);
  const known = new Map((before?.v === FILES_VERSION ? before.files : []).map((f) => [f.id, f]));
  const knownFeatures = new Map<string, Feature[]>();
  for (const f of before?.v === FILES_VERSION ? before.features : []) {
    const id = f.id.slice("file-".length, f.id.indexOf(":"));
    knownFeatures.set(id, [...(knownFeatures.get(id) ?? []), f]);
  }
  const files: CameraFile[] = [];
  const features: Feature[] = [];
  for (const id of [...ids].sort()) {
    try {
      const meta = JSON.parse((await (await get(`https://www.data.go.kr/catalog/${id}/fileData.json`)).bytes()).toString("utf8")) as {
        name?: string; alternateName?: string; dateModified?: string; encodingFormat?: string; creator?: { name?: string };
      };
      const name = meta.alternateName ?? meta.name ?? id;
      // The search also finds 방범 CCTV, 버스 승강장 …: only what names cameras or 단속.
      // Nor the counts of fines (단속 현황, 위반별), parking, rubbish and webcam lists, nor the mobile booths (not always manned).
      if (!/카메라|단속/.test(name) || SKIP_NAMES.test(name)) continue;
      const url = `https://www.data.go.kr/data/${id}/fileData.do`;
      const base = { id, name, by: meta.creator?.name ?? "", modified: meta.dateModified ?? "", url };
      const was = known.get(id);
      if (was && was.modified === base.modified) {
        files.push(was);
        features.push(...(knownFeatures.get(id) ?? []));
        continue;
      }
      if ((meta.encodingFormat ?? "CSV").toUpperCase() !== "CSV") { files.push({ ...base, rows: 0, cameras: 0, read: false, why: `${meta.encodingFormat} 파일` }); continue; }
      const page = (await (await get(url)).bytes()).toString("utf8");
      const file = /atchFileId=(FILE_\d+)/.exec(page)?.[1];
      if (!file) { files.push({ ...base, rows: 0, cameras: 0, read: false, why: "내려받을 파일 없음" }); continue; }
      const got = await get(`https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=${file}&fileDetailSn=1`);
      const bytes = await got.bytes();
      if (!got.ok || bytes.length > MAX_BYTES) { files.push({ ...base, rows: 0, cameras: 0, read: false, why: got.ok ? "파일이 너무 큼" : `내려받기 ${got.status}` }); continue; }
      const rows = rowsOf(bytes);
      const j = judge(rows, `file-${id}`, name);
      files.push({ ...base, asOf: j.asOf, sido: j.sido, rows: rows.length, cameras: j.cameras.length, read: j.read, ...(j.why ? { why: j.why } : {}) });
      if (j.read) features.push(...j.cameras);
    } catch (e) {
      log(`camera file ${id}: ${(e as Error).message}`);
    }
  }
  const kept: KeptFiles = { at: Date.now(), v: FILES_VERSION, files, features };
  writeFileSync(join(dir, "camera-files.json"), JSON.stringify(kept));
  return kept;
}

const cell = (lon: number, lat: number) => `${Math.floor(lon * 500)},${Math.floor(lat * 500)}`;
const metres = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) =>
  Math.hypot((b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180), (b.lat - a.lat) * 111_320);

/**
 * The files' cameras that fill a gap: none of [base] (the national list) within [clearM], nor one already taken from
 * a file. A file's camera beside a national one is the same camera put a little elsewhere, or its twin on the pole.
 */
export function fillGaps(base: Feature[], extra: Feature[], clearM = FILL_CLEAR_M): Feature[] {
  const grid = new Map<string, { lon: number; lat: number }[]>();
  const put = (f: { lon: number; lat: number }) => { const k = cell(f.lon, f.lat); grid.set(k, [...(grid.get(k) ?? []), f]); };
  for (const f of base) put(f);
  // Cells of 1/500° (~200 m north–south, ~180 m east–west here): the nine round a point cover clearM.
  const reach = Math.ceil(clearM / 180);
  const near = (f: Feature) => {
    const [cx, cy] = cell(f.lon, f.lat).split(",").map(Number);
    for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
      for (const o of grid.get(`${cx + dx},${cy + dy}`) ?? []) if (metres(f, o) <= clearM) return true;
    }
    return false;
  };
  const out: Feature[] = [];
  for (const f of extra) {
    if (near(f)) continue;
    out.push(f);
    put(f);
  }
  return out;
}

/** /admin's view: each agency's part of the national list, and each file the portal has, with what was taken. */
export interface Agency { code: string; name: string; sido: string; rows: number; cameras: number; asOf?: string }

/**
 * The national list's date where each file is — its biggest giver's in the file's province (경찰청, mostly; not a
 * 구청's newer parking list) — and whether the file is newer. Only a newer file fills gaps: an older one's camera the
 * list lacks may be one taken down since (울산경찰청's 2025-11 file against 경찰청's 2026-04 list).
 */
export function datedAgainst(files: CameraFile[], agencies: Agency[]): Map<string, { listAsOf?: string; newer: boolean }> {
  const mainIn = new Map<string, Agency>();
  for (const a of agencies) if (a.asOf && (!mainIn.has(a.sido) || a.cameras > mainIn.get(a.sido)!.cameras)) mainIn.set(a.sido, a);
  // A province by its new name and its old: 경찰청 still files 목포 under 전라남도, 목포시 under 전남광주통합특별시.
  const main = (sido: string) => [sido, ...(SIDO_ALIASES[sido] ?? [])].map((s) => mainIn.get(s)).filter((a): a is Agency => !!a)
    .sort((a, b) => b.cameras - a.cameras)[0];
  const out = new Map<string, { listAsOf?: string; newer: boolean }>();
  for (const f of files) {
    // A file without a 시도명 column is placed by its giver's name: "인천광역시 미추홀구".
    const names = [...mainIn.keys(), ...Object.keys(SIDO_ALIASES)];
    const sido = f.sido ?? names.find((s) => f.by.startsWith(s) || f.name.startsWith(s));
    const listAsOf = sido ? main(sido)?.asOf : undefined;
    out.set(f.id, { listAsOf, newer: !!f.asOf && !!listAsOf && f.asOf > listAsOf });
  }
  return out;
}

const SIDO_ALIASES: Record<string, string[]> = { 전남광주통합특별시: ["전라남도", "광주광역시"], 전라남도: ["전남광주통합특별시"], 광주광역시: ["전남광주통합특별시"] };

/** The cameras of the files newer than the national list where they are. */
export function newerFeatures(files: KeptFiles | null, agencies: Agency[]): Feature[] {
  if (!files) return [];
  const dated = datedAgainst(files.files, agencies);
  return files.features.filter((f) => dated.get(f.id.slice("file-".length, f.id.indexOf(":")))?.newer);
}

export function sourcesReport(agencies: Agency[], files: KeptFiles | null, filled: Feature[]) {
  const taken = new Map<string, number>();
  for (const f of filled) {
    const id = f.id.slice("file-".length, f.id.indexOf(":"));
    taken.set(id, (taken.get(id) ?? 0) + 1);
  }
  const dated = datedAgainst(files?.files ?? [], agencies);
  return {
    at: files?.at ?? null,
    agencies: [...agencies].sort((a, b) => (a.asOf ?? "").localeCompare(b.asOf ?? "")),
    files: (files?.files ?? []).map((f) => ({ ...f, filled: taken.get(f.id) ?? 0, ...dated.get(f.id) }))
      .sort((a, b) => Number(b.read) - Number(a.read) || (b.asOf ?? b.modified).localeCompare(a.asOf ?? a.modified)),
  };
}
