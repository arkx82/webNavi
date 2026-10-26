import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillGaps, findCameraFiles, judge, newerFeatures, sourcesReport, type Get, type KeptFiles } from "./camera-files.js";
import { agenciesOf } from "./cameras.js";
import type { Feature } from "./index.js";

const STD_HEAD = "무인교통단속카메라관리번호,시도명,시군구명,위도,경도,설치장소,단속구분,제한속도,데이터기준일자";
const std = (rows: string[]) => Buffer.from([STD_HEAD, ...rows].join("\n"), "utf8");

test("a file in the standard columns is read; one without positions, or only parking cameras, is not", () => {
  const rows = (b: Buffer) => b.toString("utf8").split("\n").slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [STD_HEAD.split(",")[i], v])));
  const good = judge(rows(std(["1,충청남도,당진시,36.80633,126.76136,합도초등학교앞,1,30,2026-09-14", "2,충청남도,당진시,36.81,126.77,어딘가,4,0,2026-09-14"])), "file-1");
  assert.equal(good.read, true);
  assert.equal(good.cameras.length, 1, "the parking camera left out");
  assert.equal(good.asOf, "2026-09-14");
  assert.equal(good.sido, "충청남도");
  const addressOnly = judge([{ 관리기관: "목포시", 설치장소명: "목포역", 소재지주소: "영산로 98", 설치목적구분: "불법주정차단속" }], "file-2");
  assert.deepEqual([addressOnly.read, addressOnly.why], [false, "좌표 없음 (주소만)"]);
  const parking = judge(rows(std(["1,전라남도,목포시,34.8,126.4,목포역,4,0,2026-09-04"])), "file-3");
  assert.deepEqual([parking.read, parking.why], [false, "과속·신호 카메라 없음 (주정차 등)"]);
});

test("a file in its own columns is read where its kind can be told: by the row's purpose, or by the file's name", () => {
  const hanam = judge([{ 장치아이디: "CCTVSOC001", 장치명: "고골낚시터 앞", 보호구역명: " ", 설치방향정보명: "서울→하남", 제한속도: "60", 위도: "37.52112", 경도: "127.18494", 데이터기준일자: "2024-10-05" }],
    "file-1", "경기도 하남시_하남ITS 신호과속 단속 CCTV 현황_20241005");
  assert.equal(hanam.read, true);
  assert.deepEqual([hanam.cameras[0].kind, hanam.cameras[0].limit, hanam.cameras[0].site], ["speed-signal", 60, "고골낚시터 앞 (서울→하남)"]);
  const school = judge([{ 연번: "1", 시설명: "도화초등학교", 단속방향: "제물포역→도화IC", 설치목적: "신호·과속단속", "위도": "37.46341272", " 경도 ": "126.6683645", 데이터기준일자: "2026-08-18" }],
    "file-2", "인천광역시 미추홀구_어린이보호구역 무인교통단속장비 설치현황_20260818");
  assert.deepEqual([school.read, school.cameras[0]?.kind, school.cameras[0]?.zone], [true, "speed-signal", "school"]);
  const unknown = judge([{ 무인교통단속카메라관리번호: "1", 위도: "35.17", 경도: "129.09", 설치장소: "배산역 앞" }], "file-3", "부산광역시 연제구_무인교통단속카메라 위치 현황_20261019");
  assert.deepEqual([unknown.read, unknown.why], [false, "카메라 종류(과속·신호) 없음"]);
});

test("a file's camera fills a gap only with none of the national list within 150 m, and only once", () => {
  const at = (id: string, lat: number, lon = 127): Feature => ({ id, kind: "speed", lat, lon, limit: 50 });
  const national = [at("n", 37.5)];
  const extra = [
    at("file-1:beside", 37.5 + 100 / 111_320), // 100 m north: the same camera put elsewhere
    at("file-1:gap", 37.5 + 400 / 111_320), // 400 m: a camera the list lacks
    at("file-2:gap-again", 37.5 + 450 / 111_320), // the same gap in a second file
  ];
  assert.deepEqual(fillGaps(national, extra).map((f) => f.id), ["file-1:gap"]);
});

test("the portal is searched, each file looked at once, and what each gave reported against the list's date", async () => {
  const dir = mkdtempSync(join(tmpdir(), "camfiles-"));
  const asked: string[] = [];
  const reply = (body: string | Buffer, ok = true) => ({ ok, status: ok ? 200 : 404, bytes: async () => (typeof body === "string" ? Buffer.from(body) : body) });
  const get: Get = async (url) => {
    asked.push(url);
    if (url.includes("selectDataSetList")) return reply(url.includes("currentPage=1") ? `<a href="/data/15118678/fileData.do">a</a><a href="/data/15040542/fileData.do">b</a>` : "");
    if (url.includes("/catalog/15118678/")) return reply(JSON.stringify({ alternateName: "충청남도_전국무인교통단속카메라 정보_20260914", dateModified: "2026-09-14", encodingFormat: "CSV", creator: { name: "충청남도" } }));
    if (url.includes("/catalog/15040542/")) return reply(JSON.stringify({ alternateName: "목포시_무인카메라현황_20260904", dateModified: "2026-09-04", encodingFormat: "CSV", creator: { name: "목포시" } }));
    if (url.includes("/data/15118678/")) return reply(`fn('x') href="/cmm/cmm/fileDownload.do?atchFileId=FILE_1&fileDetailSn=1"`);
    if (url.includes("/data/15040542/")) return reply(`atchFileId=FILE_2&`);
    if (url.includes("FILE_1")) return reply(std(["7,충청남도,당진시,36.80633,126.76136,합도초등학교앞,1,30,2026-09-14"]));
    if (url.includes("FILE_2")) return reply(Buffer.from("관리기관,설치장소명,소재지주소,설치목적구분\n목포시,목포역,영산로 98,불법주정차단속\n"));
    return reply("", false);
  };
  const kept = await findCameraFiles(dir, () => {}, get);
  assert.deepEqual(kept.files.map((f) => [f.id, f.read, f.cameras]), [["15040542", false, 0], ["15118678", true, 1]]);
  assert.equal(kept.features[0].id, "file-15118678:7");
  // Again, nothing changed on the portal: no file fetched twice.
  const downloads = asked.filter((u) => u.includes("fileDownload")).length;
  await findCameraFiles(dir, () => {}, get, kept);
  assert.equal(asked.filter((u) => u.includes("fileDownload")).length, downloads);
  // The report: the file newer than the national list where it is, and how many of its cameras were taken.
  const report = sourcesReport([{ code: "1320000", name: "경찰청", sido: "충청남도", rows: 2258, cameras: 2000, asOf: "2026-04-06" }], kept, kept.features);
  const cn = report.files.find((f) => f.id === "15118678")!;
  assert.deepEqual([cn.filled, cn.listAsOf, cn.asOf], [1, "2026-04-06", "2026-09-14"]);
});

test("the national list's agencies by province: rows, cameras kept and the newest date", () => {
  const rows = [
    { insttCode: "1320000", insttNm: "경찰청", ctprvnNm: "충청남도", 무인교통단속카메라관리번호: "1320000-J1", 데이터기준일자: "2026-04-06" },
    { insttCode: "1320000", insttNm: "경찰청", ctprvnNm: "대전광역시", 무인교통단속카메라관리번호: "1320000-J2", 데이터기준일자: "2026-04-06" },
    { insttCode: "6300000", insttNm: "대전광역시", ctprvnNm: "대전광역시", 무인교통단속카메라관리번호: "6300000-1", 데이터기준일자: "2022-12-15" },
  ];
  const features: Feature[] = [{ id: "police-api:1320000-J1", kind: "speed", lon: 127, lat: 36 }];
  const got = agenciesOf(rows, features);
  assert.deepEqual(got.map((a) => [a.name, a.sido, a.rows, a.cameras, a.asOf]), [
    ["경찰청", "충청남도", 1, 1, "2026-04-06"], ["경찰청", "대전광역시", 1, 0, "2026-04-06"], ["대전광역시", "대전광역시", 1, 0, "2022-12-15"],
  ]);
});

test("only a file newer than the national list where it is fills gaps; one placed by its giver's name when it has no 시도명", () => {
  const file = (id: string, by: string, asOf: string, sido?: string) => ({ id, name: `${by}_카메라`, by, modified: asOf, asOf, sido, rows: 1, cameras: 1, read: true, url: "" });
  const kept: KeptFiles = {
    at: 0, v: 1,
    files: [file("1", "충청남도", "2026-09-14", "충청남도"), file("2", "경찰청 울산광역시경찰청", "2025-11-01", "울산광역시"), file("3", "인천광역시 미추홀구", "2026-08-18")],
    features: ["1", "2", "3"].map((id) => ({ id: `file-${id}:1`, kind: "speed" as const, lon: 127, lat: 36 })),
  };
  const agencies = ["충청남도", "울산광역시", "인천광역시"].map((sido) => ({ code: "1320000", name: "경찰청", sido, rows: 10, cameras: 10, asOf: "2026-04-06" }));
  assert.deepEqual(newerFeatures(kept, agencies).map((f) => f.id), ["file-1:1", "file-3:1"]);
});
