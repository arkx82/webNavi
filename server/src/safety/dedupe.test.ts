import { test } from "node:test";
import assert from "node:assert/strict";
import { beforeOf, dedupeCameras, siteDirection, sitePlace } from "./dedupe.js";
import { SafetyIndex, featuresOf, type Feature } from "./index.js";

const cam = (id: string, over: Partial<Feature> = {}): Feature => ({ id: `police-api:${id}`, kind: "speed", lon: 127.2669788, lat: 38.0801407, ...over });

test("a site's direction and place are read alike whatever the arrow; its 전 N m too", () => {
  assert.equal(siteDirection("운천제2교차로 (포천->김화)"), "포천→김화");
  assert.equal(siteDirection("(포천→김화)"), "포천→김화");
  assert.equal(siteDirection("송정검문소 교차로(신철원>영중면)"), "신철원→영중면");
  assert.equal(siteDirection("이순신대교 시점 1차로 (여수방면)"), "여수방면");
  assert.equal(siteDirection("운천제2교차로"), null);
  assert.equal(sitePlace("민락지하차도 전100m 1,2차로(민락IC→민락교차로)"), "민락지하차도전100m");
  assert.equal(beforeOf("양문사거리전400m지점"), 400);
  assert.equal(beforeOf("숯골사거리 80m전(성남고교→금빛초교)"), 80);
  assert.equal(beforeOf("민락TG지나 300M 1,2차로"), undefined);
});

test("one camera from two agencies is one row: the one that names its direction, at the lower limit (운천제2교차로 G1211, 2026-10-11)", () => {
  const { features, merged } = dedupeCameras([
    cam("5600000-G1211", { lon: 127.2670087, lat: 38.0801511, limit: 80, direction: "1", site: "운천제2교차로", ways: [{ deg: 315, at: [127.266856, 38.080033] }] }),
    cam("1320000-G1211", { limit: 70, direction: "1", site: "운천제2교차로 (포천->김화)", ways: [{ deg: 315, at: [127.266848, 38.08004] }, { deg: 225, at: [127.267168, 38.080054] }] }),
  ]);
  assert.equal(features.length, 1);
  assert.equal(features[0].id, "police-api:1320000-G1211");
  assert.equal(features[0].limit, 70);
  assert.equal(features[0].site, "운천제2교차로 (포천->김화)");
  // The ways of both rows, each once.
  assert.deepEqual(features[0].ways?.map((w) => w.deg).sort(), [225, 315]);
  assert.deepEqual(merged[0].limits, [70, 80]);
});

test("two cameras on one pole, one each way, stay two; so do rows of other places at one placeholder point", () => {
  const { features } = dedupeCameras([
    cam("1320000-G1359", { limit: 50, direction: "1", site: "압록보건진료소 앞(곡성→구례)" }),
    cam("1320000-G1360", { limit: 50, direction: "2", site: "압록보건진료소 앞(구례→곡성)" }),
    cam("5835000-7", { limit: 40, direction: "01", site: "곡성군 오곡면 압록리 597 압록보건진료소 앞(곡성→구례)", lon: 127.26699 }),
    cam("5835000-8", { limit: 40, direction: "02", site: "곡성군 오곡면 압록리 597 압록보건진료소 앞(구례→곡성)", lon: 127.26699 }),
    cam("5480000-J0007", { lat: 38.081, limit: 70, direction: "2", site: "교동교차로(진주행)" }),
    cam("5480000-J0016", { lat: 38.081, limit: 30, direction: "1", site: "초계초등학교(합천→창녕)" }),
  ]);
  // 곡성→구례 of both agencies one camera, 구례→곡성 another, each at 40; the placeholder pair untouched.
  assert.deepEqual(features.map((f) => `${f.id.slice(11)} ${f.limit}`).sort(), ["1320000-G1359 40", "1320000-G1360 40", "5480000-J0007 70", "5480000-J0016 30"]);
});

test("one agency's lane cameras of one carriageway are one; its two rows of a place with no direction said, metres apart, are not", () => {
  const { features } = dedupeCameras([
    cam("1320000-J6307", { limit: 60, direction: "2", site: "민락지하차도 전100m 1,2차로(민락IC→민락교차로)" }),
    cam("1320000-J6308", { limit: 60, direction: "2", site: "민락지하차도 전100m 3,4차로(민락IC→민락교차로)" }),
    cam("1320000-F9848", { kind: "signal", lat: 38.09, limit: 80, direction: "1", site: "학곡교차로" }),
    cam("1320000-F9849", { kind: "signal", lat: 38.09002, limit: 60, direction: "1", site: "학곡교차로" }),
  ]);
  assert.deepEqual(features.map((f) => f.id.slice(11)), ["1320000-J6307", "1320000-F9848", "1320000-F9849"]);
});

test("a camera its site puts 400 m before the junction is not the junction's camera of another kind at the same point (양문사거리)", () => {
  const index = new SafetyIndex().add(featuresOf([
    { 무인교통단속카메라관리번호: "5600000-F6124", 위도: "37.99948485", 경도: "127.2468833", 단속구분: "2", 제한속도: "80", 도로노선방향: "1", 설치장소: "양문사거리" },
    { 무인교통단속카메라관리번호: "5600000-F6204", 위도: "37.99948485", 경도: "127.2468833", 단속구분: "1", 제한속도: "80", 도로노선방향: "1", 설치장소: "양문사거리전400m지점" },
  ], "police-api")).build();
  assert.deepEqual(index.features.map((f) => [f.kind, f.site, f.beforeM]), [["signal", "양문사거리", undefined], ["speed", "양문사거리전400m지점", 400]]);
  assert.deepEqual(index.merged, []);
});

test("the index keeps one row of a camera given twice, and says what it merged", () => {
  const index = new SafetyIndex().add([
    cam("1320000-G3351", { kind: "signal", lon: 127.2807621, lat: 38.1014521, limit: 70, direction: "2", site: "송정검문소 교차로(신철원>영중면)" }),
    cam("5600000-G3351", { kind: "signal", lon: 127.280832, lat: 38.1015065, limit: 80, direction: "2", site: "송정검문소교차로" }),
    { id: "bump", kind: "bump", lon: 127.2807621, lat: 38.1014521 },
  ]).build();
  assert.deepEqual(index.features.map((f) => f.id), ["police-api:1320000-G3351", "bump"]);
  assert.equal(index.merged.length, 1);
  assert.equal(index.near(127.2807621, 38.1014521, 50).filter((f) => f.kind === "signal").length, 1);
});
