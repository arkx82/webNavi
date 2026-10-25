import { test } from "node:test";
import assert from "node:assert/strict";
import { offset } from "./geo";
import { SafeDrive, type SafeDeps } from "./safe-drive";
import { phraseFor, type Feature } from "./warnings";
import type { LonLat } from "./types";

const start: LonLat = [127.0276, 37.4979];
const lonLat = (p: LonLat) => ({ lon: p[0], lat: p[1] });
const settle = () => new Promise((done) => setImmediate(done));

/** A server whose road runs on as the car heads, [m] long, a vertex every 25 m; [asked] counts the asks. */
function deps(features: Feature[], clock: { t: number }, asked = { n: 0 }): SafeDeps {
  return {
    ahead: async (at, deg, m) => {
      asked.n++;
      return { path: Array.from({ length: Math.floor(m / 25) + 1 }, (_, i) => offset(at, deg, i * 25)) };
    },
    near: async () => features,
    prefs: () => ({ wants: () => true, cameraFromM: 600 }),
    log: () => {},
    now: () => clock.t,
  };
}

test("안전운전: a camera on the road ahead is said at each rung once, with no route", async () => {
  const clock = { t: 0 };
  const cam: Feature = { id: "cam", kind: "signal", ...lonLat(offset(start, 0, 1600)), limit: 50 };
  const safe = new SafeDrive(deps([cam], clock));
  const said: string[] = [];
  for (let m = 0; m <= 2000; m += 25) {
    const at = offset(start, 0, m);
    safe.trailAt(at);
    const along = safe.update(at, 0, 15);
    if (along != null && safe.watch) for (const due of safe.watch.due(along)) said.push(phraseFor(due));
    clock.t += 1700;
    await settle();
  }
  assert.deepEqual(said, ["육백미터 앞에 신호 단속 카메라가 있습니다, 제한 속도 오십입니다", "삼백미터 앞에 신호 단속 카메라가 있습니다, 제한 속도 오십입니다"]);
});

test("안전운전: a 구간 단속 begun behind the car holds on every new road ahead until its end", async () => {
  const clock = { t: 0 };
  const startCam: Feature = { id: "s", kind: "section-start", ...lonLat(offset(start, 0, 300)), limit: 80, direction: "1", pair: offset(start, 0, 6000) };
  const endCam: Feature = { id: "e", kind: "section-end", ...lonLat(offset(start, 0, 6000)), limit: 80, direction: "1", pair: offset(start, 0, 300) };
  const asked = { n: 0 };
  const safe = new SafeDrive(deps([startCam, endCam], clock, asked));
  const inside: number[] = [];
  for (let m = 0; m <= 6500; m += 25) {
    const at = offset(start, 0, m);
    safe.trailAt(at);
    const along = safe.update(at, 0, 25);
    if (along != null && safe.watch?.currentSection(along)) inside.push(m);
    clock.t += 1000;
    await settle();
  }
  // Asked again as the road ahead ran short, and the stretch held through each new one: from its start to its end.
  assert.ok(asked.n >= 3, `${asked.n}`);
  assert.ok(inside[0] >= 300 && inside[0] <= 350, `${inside[0]}`);
  assert.ok(inside[inside.length - 1] >= 5950 && inside[inside.length - 1] <= 6000, `${inside[inside.length - 1]}`);
  assert.equal(inside.length, (inside[inside.length - 1] - inside[0]) / 25 + 1, "no gap");
});

test("안전운전: after a U-turn the camera ahead on the other carriageway is not put on the way come", async () => {
  const clock = { t: 0 };
  // Up the east carriageway 1 km, then back down the west one, 20 m over.
  const turn = offset(start, 0, 1000);
  const west = offset(turn, 270, 20);
  // Listed between the two, nearer the way come: on the way come, it would be behind the car.
  const cam: Feature = { id: "south", kind: "speed", ...lonLat(offset(offset(west, 180, 700), 90, 12)), limit: 60, ways: [{ deg: 180, at: offset(west, 180, 700) }] };
  const safe = new SafeDrive(deps([cam], clock));
  for (let m = 0; m <= 1000; m += 25) {
    safe.trailAt(offset(start, 0, m));
    safe.update(offset(start, 0, m), 0, 15);
    clock.t += 1700;
    await settle();
  }
  const said: string[] = [];
  for (let m = 0; m <= 600; m += 25) {
    const at = offset(west, 180, m);
    safe.trailAt(at);
    const along = safe.update(at, 180, 15);
    if (along != null && safe.watch) for (const due of safe.watch.due(along)) said.push(phraseFor(due));
    clock.t += 1700;
    await settle();
  }
  assert.deepEqual(said, ["육백미터 앞에 과속 단속 카메라가 있습니다, 제한 속도 육십입니다", "삼백미터 앞에 과속 단속 카메라가 있습니다, 제한 속도 육십입니다"]);
});
