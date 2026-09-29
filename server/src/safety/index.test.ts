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
  assert.equal(features[1].kind, "school");
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
