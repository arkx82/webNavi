import { test } from "node:test";
import assert from "node:assert/strict";
import { alertsFor, covers, parseStatus } from "./alerts.js";
import { gradeOf, pickStation, sidoNames } from "./air.js";
import { cleanMessage, incidentFeatures, incidentKind } from "./road/incidents.js";
import { restAreas } from "./road/rest-areas.js";
import { bumpFeatures, schoolZoneFeatures, seniorZoneFeatures } from "./safety/datasets.js";

const goyang = { sido: "경기도", sigungu: "고양시 덕양구", dongs: ["행신동", "행신2동"] };
const gangnam = { sido: "서울특별시", sigungu: "강남구", dongs: ["역삼동", "역삼1동"] };

test("기상청's status text becomes warnings, a province's list kept whole", () => {
  const w = parseStatus("o 호우경보 : 서울, 경기도(고양, 파주, 김포)\r\no 강풍주의보 : 강원도(강원북부산지, 강원중부산지), 울릉도.독도\r\n");
  assert.deepEqual(w.map((x) => `${x.kind}${x.level}`), ["호우경보", "강풍주의보"]);
  assert.deepEqual(w[0].areas, ["서울", "경기도(고양, 파주, 김포)"]);
  assert.deepEqual(parseStatus("o 없 음"), []);
});

test("an area covers the car by its province, its city, or (maybe) a zone of it", () => {
  assert.equal(covers("경기도(고양, 파주)", goyang), "here");
  assert.equal(covers("경기도(수원, 성남)", goyang), null);
  assert.equal(covers("경기도", goyang), "here");
  assert.equal(covers("서울(서울동남권)", gangnam), "part");
  assert.equal(covers("강원도(강원북부산지)", goyang), null);
  assert.equal(covers("강원도", { sido: "강원특별자치도", sigungu: "춘천시", dongs: [] }), "here");
  const got = alertsFor(parseStatus("o 호우주의보 : 경기도(수원)\no 호우경보 : 경기도(고양, 파주)"), goyang);
  assert.deepEqual(got.map((a) => `${a.kind}${a.level}:${a.where}`), ["호우경보:here"]);
});

test("에어코리아's province names, a merged province read as both", () => {
  assert.deepEqual(sidoNames("서울특별시"), ["서울"]);
  assert.deepEqual(sidoNames("전북특별자치도"), ["전북"]);
  assert.deepEqual(sidoNames("충청남도"), ["충남"]);
  assert.deepEqual(sidoNames("전남광주통합특별시"), ["광주", "전남"]);
});

test("the station for the car is its 동's, else its 구's, else the province's middle", () => {
  const rows = [
    { stationName: "역삼동", pm10Value: "40", pm25Value: "20", pm10Grade1h: "2", pm25Grade1h: "2", dataTime: "2026-09-30 10:00" },
    { stationName: "강남구", pm10Value: "90", pm25Value: "50", pm10Grade1h: "3", pm25Grade1h: "3" },
    { stationName: "종로구", pm10Value: "-", pm25Value: "-" },
  ];
  assert.equal(pickStation(rows, gangnam)?.station, "역삼동");
  assert.equal(pickStation(rows.slice(1), gangnam)?.station, "강남구");
  const mid = pickStation(rows, { sido: "서울특별시", sigungu: "마포구", dongs: ["서교동"] });
  assert.equal(mid?.province, true);
  assert.equal(mid?.pm10Grade, gradeOf("pm10", mid!.pm10!));
  assert.equal(gradeOf("pm25", 36), 3);
});

test("ITS events: a crash, roadworks, a breakdown; a promotion is not on the road", () => {
  assert.equal(incidentKind({ eventType: "교통사고" }), "incident-crash");
  assert.equal(incidentKind({ eventType: "공사", eventDetailType: "작업" }), "incident-work");
  assert.equal(incidentKind({ eventType: "기타돌발", eventDetailType: "고장" }), "incident-other");
  assert.equal(incidentKind({ eventType: "기타", eventDetailType: "이벤트/홍보" }), null);
  const [f] = incidentFeatures([{ eventType: "공사", eventDetailType: "작업", coordX: "126.8", coordY: "37.6", roadName: "수도권제1순환선", lanesBlocked: "2차로 차단", message: "루프센서보수작업", linkId: "1", startDate: "2026" }]);
  assert.equal(f.kind, "incident-work");
  assert.equal(f.detail, "수도권제1순환선 · 작업 · 2차로 차단");
});

test("a rest area takes its station's prices by name and its amenities by code", () => {
  const [a] = restAreas(
    [{ unitName: "서울만남(부산)휴게소", xValue: "127.04", yValue: "37.46", stdRestCd: "000001", routeName: "경부선" }],
    [{ serviceAreaName: "서울만남(부산)주유소", gasolinePrice: "1,864원", diselPrice: "1,853원", lpgPrice: "1,186원", lpgYn: "Y", oilCompany: "AD" }],
    [{ stdRestCd: "000001", psName: "수유실" }, { stdRestCd: "000001", psName: "샤워실" }, { stdRestCd: "000002", psName: "쉼터" }],
  );
  assert.equal(a.kind, "rest-area");
  assert.deepEqual(a.rest, { route: "경부선", gasoline: 1864, diesel: 1853, lpg: 1186, brand: "AD", amenities: ["수유실", "샤워실"] });
});

test("bumps taken out are dropped; school zones are points held at 30", () => {
  const bumps = bumpFeatures([
    { MNG_NO: "1", WGS84_LAT: "37.7", WGS84_LOT: "126.8", ROAD_NM: "내산길", DAT_UPDT_SE: "I" },
    { MNG_NO: "2", WGS84_LAT: "37.7", WGS84_LOT: "126.8", DAT_UPDT_SE: "D" },
    { MNG_NO: "1", WGS84_LAT: "37.7", WGS84_LOT: "126.8", DAT_UPDT_SE: "U" },
  ]);
  assert.deepEqual(bumps.map((b) => b.id), ["bump:1"]);
  const [z] = schoolZoneFeatures([{ trgetFcltyNm: "신기초등학교", fcltyKnd: "초등학교", latitude: "34.76", longitude: "127.67", insttCode: "5785000" }]);
  assert.equal(z.kind, "school-zone");
  assert.equal(z.limit, 30);
  assert.equal(z.radiusM, undefined);
});

test("a message sent as fields is cut to the sentence a driver reads", () => {
  assert.equal(
    cleanMessage("<공사>::성산로::금화터널북측::금화터널남측::2차로::[공사] 금화터널 자동화재탐지설비 점검 / 장소: 금화터널 양방향 터널 / 2차로 부분통제::유지보수  서울청"),
    "금화터널 자동화재탐지설비 점검",
  );
  assert.equal(cleanMessage("(1,2차로)장애물 처리중(동물사체)"), "(1,2차로)장애물 처리중(동물사체)");
});

test("motorways and car-only roads are known by their names", async () => {
  const { isMotorwayName, markMotorway } = await import("./route/types.js");
  for (const n of ["동부간선도로", "경부고속도로", "강변북로", "올림픽대로", "수도권제1순환고속도로", "내부순환로", "분당수서간도시고속화도로"]) assert.ok(isMotorwayName(n), n);
  for (const n of ["테헤란로", "동일로", "노원로", "역삼로", undefined]) assert.ok(!isMotorwayName(n), String(n));
  const r = { provider: "kakao" as const, distanceM: 0, durationS: 0, path: [], guides: [], segments: [] };
  markMotorway(r, 0, 10);
  markMotorway(r, 10, 20);
  markMotorway(r, 30, 40);
  assert.deepEqual((r as { motorways?: [number, number][] }).motorways, [[0, 20], [30, 40]]);
});

test("traffic lights: vehicle lamps and flashing ones, one a corner, with their night hours", async () => {
  const { lightFeatures } = await import("./safety/datasets.js");
  const got = lightFeatures([
    { tfclghtSe: "1", latitude: "37.5", longitude: "127.0", tfclghtManageNo: "a", opratnYn: "Y", flashingLightOpenHhmm: "00:00", flashingLightCloseHhmm: "05:00", sgnaspOrdr: "녹색+황색+적색" },
    { tfclghtSe: "01", latitude: "37.50001", longitude: "127.00001", tfclghtManageNo: "b" },
    { tfclghtSe: "2", latitude: "37.6", longitude: "127.1", tfclghtManageNo: "walk" },
    { tfclghtSe: "6", latitude: "37.7", longitude: "127.2", tfclghtManageNo: "amber", opratnYn: "N" },
    { tfclghtSe: "1", latitude: "37.8", longitude: "127.3", tfclghtManageNo: "c", opratnYn: "Y", flashingLightOpenHhmm: "00:00", flashingLightCloseHhmm: "00:00" },
    { tfclghtSe: "1", latitude: "37.9", longitude: "127.4", tfclghtManageNo: "allday", opratnYn: "Y", flashingLightOpenHhmm: "00:00", flashingLightCloseHhmm: "23:59" },
    { tfclghtSe: "1", latitude: "38.0", longitude: "127.5", tfclghtManageNo: "late", opratnYn: "Y", flashingLightOpenHhmm: "23:00", flashingLightCloseHhmm: "06:00" },
  ]);
  assert.deepEqual(got.map((f) => [f.id, f.flash ?? null]), [["light:a", "00:00-05:00"], ["light:amber", "always"], ["light:c", null], ["light:allday", null], ["light:late", "23:00-06:00"]]);
});

test("Seoul's signal heads: vehicle lamps only, from the city's grid to longitude and latitude", async () => {
  const { seoulLightFeatures } = await import("./safety/datasets.js");
  const got = seoulLightFeatures([
    { ATCH_MNG_NO1: "03-1", TRFC_LGHT_KND: "002", XCRD: "200000", YCRD: "550000" },
    { ATCH_MNG_NO1: "03-2", TRFC_LGHT_KND: "007", XCRD: "200100", YCRD: "550100" },
    { ATCH_MNG_NO1: "03-3", TRFC_LGHT_KND: "003", XCRD: "200000.5", YCRD: "550000.5" },
  ]);
  assert.equal(got.length, 1);
  // 200000, 550000 in EPSG:5186 is on 127°E, about 45 km south of 38°N.
  assert.ok(Math.abs(got[0].lon - 127) < 0.001, `${got[0].lon}`);
  assert.ok(Math.abs(got[0].lat - 37.549) < 0.01, `${got[0].lat}`);
});

test("노면색깔유도선: colours read however they are written, junctions found by name whatever their kind", async () => {
  const { colourOf, junctionKey, parseGuides, ColourGuides } = await import("./road/color-guides.js");
  assert.equal(colourOf("분홍"), "pink");
  assert.equal(colourOf("연한 녹색"), "green");
  assert.equal(colourOf("청색(1차선, 2차선)"), "blue");
  assert.equal(colourOf(""), undefined);
  assert.equal(junctionKey("부평 나들목"), junctionKey("부평IC"));
  assert.equal(junctionKey("신갈분기점"), junctionKey("신갈JC"));
  assert.notEqual(junctionKey("용인 나들목"), junctionKey("용인JC"), "an IC is not the JC of the same name");
  const csv = "구분,노선명,시설물 명칭,방향,분기형태,좌,우,비고\n" +
    "1,경인선,부평 나들목,인천,1점2분기,녹색,분홍색,나들목\n" +
    "2,서해안선,안산 분기점,목포,2점2분기,녹색,분홍,분기점\n" +
    "3,서해안선,안산 분기점,서울,1점1분기,분홍색,,분기점\n" +
    "4,경부선,서울 영업소,부산,영업소,청색,주황색,영업소\n";
  const rows = parseGuides(csv);
  assert.equal(rows.length, 3, "the toll plaza left out");
  // Two directions that differ: the one whose town lies ahead.
  const dir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "cg-"));
  (await import("node:fs")).writeFileSync((await import("node:path")).join(dir, "color-guides.csv"), csv);
  const towns: Record<string, [number, number]> = { 목포: [126.39, 34.81], 서울: [126.98, 37.57] };
  const g = new ColourGuides(dir, async (t) => towns[t] ?? null);
  const at: [number, number] = [126.8, 37.3];
  assert.deepEqual(await g.at("안산JC", at, 200), { left: "green", right: "pink", facility: "안산 분기점", route: "서해안선", towards: "목포" });
  assert.equal((await g.at("안산JC", at, 20))?.towards, "서울");
  assert.equal((await g.at("부평IC", at, 0))?.right, "pink");
  assert.equal(await g.at("없는JC", at, 0), null);
  // The line the route is on, where the junction is on two.
  assert.equal((await g.at("안산JC", at, 20, ["서해안"]))?.route, "서해안선");
});

test("senior zones keep each row's own limit, two on one longitude not confused", () => {
  const rows = [
    { latitude: "37.5000", longitude: "127.0000", lmttVe: "30", trgetFcltyNm: "경로당" },
    { latitude: "37.6000", longitude: "127.0000", lmttVe: "50", trgetFcltyNm: "복지관" },
    { latitude: "37.7000", longitude: "127.1000", lmttVe: "0", trgetFcltyNm: "요양원" },
    { latitude: "", longitude: "127.2000", lmttVe: "30" },
  ];
  const got = seniorZoneFeatures(rows);
  assert.deepEqual(got.map((f) => [f.name, f.limit]), [["경로당", 30], ["복지관", 50], ["요양원", undefined]]);
  assert.ok(got.every((f) => f.kind === "senior-zone" && f.id.startsWith("senior-zone:")));
  assert.equal(schoolZoneFeatures(rows)[0].limit, 30);
});

test("a town the geocoder could not place is asked again after ten minutes, one placed never", async (t) => {
  const { ColourGuides } = await import("./road/color-guides.js");
  const csv = "구분,노선명,시설물 명칭,방향,분기형태,좌,우,비고\n" +
    "2,서해안선,안산 분기점,목포,2점2분기,녹색,분홍,분기점\n" +
    "3,서해안선,안산 분기점,서울,1점1분기,분홍색,,분기점\n";
  const dir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "cg-"));
  (await import("node:fs")).writeFileSync((await import("node:path")).join(dir, "color-guides.csv"), csv);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const asked: string[] = [];
  let down = true;
  const towns: Record<string, [number, number]> = { 목포: [126.39, 34.81], 서울: [126.98, 37.57] };
  const g = new ColourGuides(dir, async (town) => { asked.push(town); if (down) throw new Error("down"); return towns[town] ?? null; });
  const at: [number, number] = [126.8, 37.3];
  assert.equal(await g.at("안산JC", at, 200), null, "nothing placed while the geocoder is down");
  assert.deepEqual(asked, ["목포", "서울"]);
  down = false;
  await g.at("안산JC", at, 200);
  assert.deepEqual(asked, ["목포", "서울"], "within ten minutes the misses are not asked again");
  t.mock.timers.tick(10 * 60_000 + 1);
  assert.equal((await g.at("안산JC", at, 200))?.towards, "목포");
  assert.deepEqual(asked, ["목포", "서울", "목포", "서울"], "after ten minutes they are");
  t.mock.timers.tick(60 * 60_000);
  assert.equal((await g.at("안산JC", at, 20))?.towards, "서울");
  assert.deepEqual(asked, ["목포", "서울", "목포", "서울"], "placed towns are kept");
});

test("a leg that spans the globe is walked a bounded number of steps, not for ever", async () => {
  const { cellsAlong } = await import("./road/traffic.js");
  const began = Date.now();
  const cells = cellsAlong([[127, 37], [1e300, 37]]);
  assert.ok(Date.now() - began < 2000);
  assert.ok(cells.size >= 1);
});
