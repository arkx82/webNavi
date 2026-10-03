import { test } from "node:test";
import assert from "node:assert/strict";
import { SafetyIndex, metres, parseStandardData } from "./index.js";

test("metres is close to the haversine answer over a kilometre", () => {
  // Gangnam station to Yeoksam station, about 690 m.
  const d = metres(127.0276, 37.4979, 127.0363, 37.5006);
  assert.ok(d > 800 && d < 830, `${d}`);
});

test("near returns only what is inside the radius, nearest first", () => {
  const index = new SafetyIndex()
    .add([
      { id: "a", kind: "speed", lon: 127.0276, lat: 37.4979 },
      { id: "b", kind: "bump", lon: 127.0363, lat: 37.5006 },
      { id: "c", kind: "signal", lon: 127.1, lat: 37.6 },
    ])
    .build();
  const found = index.near(127.028, 37.498, 1000);
  assert.deepEqual(found.map((f) => f.id), ["a", "b"]);
  assert.ok(found[0].distanceM < found[1].distanceM);
});

test("the police CSV is read by column name, in either byte order", () => {
  const csv =
    "무인교통단속카메라관리번호,시도명,도로노선명,도로노선방향,위도,경도,단속구분,제한속도,보호구역구분\n" +
    "1,서울,강남대로,상행,37.4979,127.0276,1,60,\n" +
    "2,서울,테헤란로,하행,37.5006,127.0363,01,30,어린이보호구역\n" +
    "3,서울,,,0,0,1,60,\n" +
    "4,서울,강남대로,,37.4990,127.0280,4,,\n";
  const features = parseStandardData(csv, "전국무인교통단속카메라표준데이터.csv");
  // The one without a position and the bus-lane camera are not kept.
  assert.equal(features.length, 2);
  assert.equal(features[0].kind, "speed");
  assert.equal(features[0].limit, 60);
  assert.equal(features[0].direction, "상행");
  // A camera in a school zone is still a speed camera (said as one, with its limit), marked as the zone's.
  assert.equal(features[1].kind, "speed");
  assert.equal(features[1].zone, "school");
});

test("the camera API's English fields read as the CSV's Korean ones", async () => {
  const { korean } = await import("./cameras.js");
  const { featuresOf } = await import("./index.js");
  const rows = [
    { insttCode: "611", mnlssRegltCameraManageNo: "16", latitude: "37.5", longitude: "127.03", regltSe: "1", lmttVe: "50", roadRouteNm: "테헤란로" },
    { insttCode: "626", mnlssRegltCameraManageNo: "16", latitude: "37.5", longitude: "127.04", regltSe: "99", regltSctnLcSe: "1", lmttVe: "80" },
    { insttCode: "626", mnlssRegltCameraManageNo: "17", latitude: "37.51", longitude: "127.05", regltSe: "99", regltSctnLcSe: "2", lmttVe: "80" },
    { insttCode: "626", mnlssRegltCameraManageNo: "18", latitude: "37.5", longitude: "127.06", regltSe: "01+02", lmttVe: "60" },
    { insttCode: "626", mnlssRegltCameraManageNo: "19", latitude: "37.5", longitude: "127.07", regltSe: "04" },
    { insttCode: "626", mnlssRegltCameraManageNo: "20", latitude: "", longitude: "", regltSe: "2" },
  ].map(korean);
  const out = featuresOf(rows, "police-api");
  // The same number from two agencies stays two cameras; the bus lane goes.
  assert.deepEqual(out.map((f) => [f.id, f.kind, f.limit]), [
    ["police-api:611-16", "speed", 50],
    ["police-api:626-16", "section-start", 80],
    ["police-api:626-17", "section-end", 80],
    ["police-api:626-18", "speed-signal", 60],
  ]);
});

test("a school zone's limit is its cameras': 50 where they say 50, none where they disagree or there are none", async () => {
  const { zoneLimits } = await import("./index.js");
  const school = (id: string, lon: number) => ({ id, kind: "school-zone" as const, lon, lat: 37.5, limit: 30, radiusM: 200 });
  const cam = (id: string, lon: number, limit: number, zone: "school" | "senior" | null = "school") => ({ id, kind: "speed" as const, lon, lat: 37.5005, limit, ...(zone ? { zone } : {}) });
  const features = [
    school("wide", 127.0), cam("c1", 127.0005, 50), cam("c2", 127.001, 50),
    school("both", 127.1), cam("c3", 127.1005, 50), cam("c4", 127.0995, 30),
    school("none", 127.2), cam("c5", 127.2005, 60, null),
    school("lane", 127.3), cam("c6", 127.3008, 30),
  ];
  zoneLimits(features);
  const limit = (id: string) => features.find((f) => f.id === id)!.limit;
  assert.equal(limit("wide"), 50);
  assert.equal(limit("both"), undefined, "a 50 road one side and a 30 lane the other: the route's own camera decides");
  assert.equal(limit("none"), undefined, "a camera that is not the zone's says nothing of it");
  assert.equal(limit("lane"), 30);
  assert.equal(limit("c1"), 50, "the cameras keep theirs");
});
