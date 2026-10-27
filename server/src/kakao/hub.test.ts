import { test } from "node:test";
import assert from "node:assert/strict";
import { KakaoHub, SLOT_IDLE_MS, kindOf } from "./hub.js";

const fix = { lon: 127, lat: 37.5, speed: 15, bearing: 0, acc: 5 };
const ready = (hub: KakaoHub, n: number) => hub.appEvent(n, { kind: "status", state: "ready" });

test("카카오's codes as our kinds: the cameras and the school zone, nothing else", () => {
  assert.equal(kindOf("KNSafetyCode_SpeedViolationCamera"), "speed");
  assert.equal(kindOf("KNSafetyCode_SignalAndSpeedViolationBackwardCamera"), "speed-signal");
  assert.equal(kindOf("KNSafetyCode_SignalViolationCamera"), "signal");
  assert.equal(kindOf("KNSafetyCode_SpeedViolationSectionInOnlyCamera"), "section-start");
  assert.equal(kindOf("KNSafetyCode_SpeedViolationSectionOutCamera"), "section-end");
  assert.equal(kindOf("KNSafetyCode_ChildrenProtectionZone"), "school-zone");
  assert.equal(kindOf("KNSafetyCode_Hump"), null);
  assert.equal(kindOf("KNSafetyCode_ParkingViolationCamera"), null);
});

test("cars get a slot while one is free and up; a third car waits; an idle car's slot is let go", () => {
  let now = 0;
  const hub = new KakaoHub(2, () => "key", () => now);
  assert.equal(hub.ready, false, "no app up yet");
  ready(hub, 1); ready(hub, 2);
  assert.equal(hub.ready, true);
  assert.equal(hub.carFix("a", fix).slot, 1);
  assert.equal(hub.carFix("b", fix).slot, 2);
  assert.equal(hub.carFix("a", fix).slot, 1, "the same car keeps its slot");
  assert.deepEqual([hub.carFix("c", fix).slot, hub.carFix("c", fix).why], [null, "busy"]);
  now += SLOT_IDLE_MS + 1;
  ready(hub, 1); ready(hub, 2);
  hub.carFix("a", fix);
  assert.equal(hub.carFix("c", fix).slot, 2, "b's slot freed after its fixes stopped");
});

test("the app's long ask wakes at the car's fix, and what the SDK would say reaches that car once", async () => {
  let now = 0;
  const hub = new KakaoHub(1, () => "key", () => now);
  ready(hub, 1);
  const asked = hub.appAsk(1, 0, 5000);
  hub.carFix("a", fix);
  const got = await asked;
  assert.equal(got?.active, true);
  assert.equal(got?.fix?.lon, 127);
  assert.equal(got?.appKey, "key");
  hub.appEvent(1, { kind: "voice", safety: { id: 9, code: "KNSafetyCode_SpeedViolationCamera", lon: 127.001, lat: 37.505, limit: 60, dist: 580 } });
  hub.appEvent(1, { kind: "voice", safety: { id: 10, code: "KNSafetyCode_Hump", lon: 127, lat: 37.5, dist: 100 } });
  const first = hub.carFix("a", fix);
  assert.deepEqual(first.events.map((e) => [e.kind, e.limit, e.dist]), [["speed", 60, 580]]);
  assert.equal(hub.carFix("a", fix).events.length, 0, "said once");
  // One left waiting past its use is dropped.
  hub.appEvent(1, { kind: "voice", safety: { id: 11, code: "KNSafetyCode_SignalViolationCamera", lon: 127, lat: 37.5, dist: 300 } });
  now += 20_000;
  ready(hub, 1);
  assert.equal(hub.carFix("a", fix).events.length, 0);
});
