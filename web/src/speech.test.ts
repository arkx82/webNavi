import { test } from "node:test";
import assert from "node:assert/strict";
import { ALERT_KINDS, ALERT_LEVELS, alertPhrase, fixedPhrases } from "../../server/src/phrases";
import { EVENTS, spokenGuide, turnRungs, turnSpeech } from "./speech";
import { phraseFor, type Kind } from "./warnings";
import type { Maneuver } from "./maneuver";

test("a left turn is said at 300 m in town, then 잠시 후, once each", () => {
  const said = new Set<number>();
  assert.equal(turnSpeech("left", 450, 50, said, ""), null);
  assert.equal(turnSpeech("left", 290, 50, said, ""), "삼백미터 앞에서 좌회전입니다");
  assert.equal(turnSpeech("left", 250, 50, said, ""), null);
  assert.equal(turnSpeech("left", 140, 50, said, ""), "잠시 후 좌회전입니다");
  assert.equal(turnSpeech("left", 60, 50, said, ""), null);
});

test("on a fast road the turn comes at 1 km and 500 m", () => {
  const said = new Set<number>();
  assert.equal(turnSpeech("ramp-right", 980, 100, said, ""), "일킬로미터 앞에서 오른쪽 출구입니다");
  assert.equal(turnSpeech("ramp-right", 480, 100, said, ""), "오백미터 앞에서 오른쪽 출구입니다");
});

test("a turn first seen close in is only 잠시 후, not every rung in one breath", () => {
  const said = new Set<number>();
  assert.equal(turnSpeech("right", 120, 50, said, ""), "잠시 후 우회전입니다");
  assert.equal(turnSpeech("right", 100, 50, said, ""), null);
});

test("a turn first known well inside a far rung waits for 잠시 후 rather than say the wrong distance", () => {
  const said = new Set<number>();
  assert.equal(turnSpeech("right", 171, 90, said, ""), null); // not "500미터 앞" at 171 m
  assert.equal(turnSpeech("right", 160, 90, said, ""), null);
  assert.equal(turnSpeech("right", 145, 90, said, ""), "잠시 후 우회전입니다");
  assert.equal(turnSpeech("right", 380, 90, new Set(), ""), "오백미터 앞에서 우회전입니다"); // 76 %: close enough
});

test("straight on and the arrival are said once, close in", () => {
  assert.equal(turnSpeech("straight", 290, 50, new Set(), ""), null);
  assert.equal(turnSpeech("straight", 140, 50, new Set(), ""), "잠시 후 직진입니다");
  assert.equal(turnSpeech("arrive", 140, 50, new Set(), ""), EVENTS.nearGoal);
});

test("provider text is made sayable for a manoeuvre with no word of its own", () => {
  assert.equal(spokenGuide("선릉역에서 강남구청 방면으로 좌회전 후 선릉로를 따라 15m 이동"), "선릉역에서 강남구청 방면으로 좌회전");
  assert.equal(spokenGuide("강남역에서 '역삼역' 방면으로 좌회전"), "강남역에서 역삼역 방면으로 좌회전");
  assert.equal(turnSpeech("other", 140, 50, new Set(), "톨게이트 통과"), "잠시 후 톨게이트 통과");
});

test("every sentence the page can say from the vocabulary is one the server renders ahead", () => {
  const fixed = new Set(fixedPhrases());
  const turns: Maneuver[] = ["straight", "left", "right", "slight-left", "slight-right", "sharp-left", "sharp-right", "uturn", "ramp-left", "ramp-right", "roundabout", "arrive"];
  for (const speed of [30, 100]) {
    for (const m of turns) {
      for (let inM = 1100; inM >= 0; inM -= 10) {
        const s = turnSpeech(m, inM, speed, new Set(), "");
        if (s) assert.ok(fixed.has(s), `not rendered ahead: ${s}`);
      }
    }
  }
  for (const e of Object.values(EVENTS)) assert.ok(fixed.has(e), e);
  const kinds: Kind[] = ["speed", "signal", "speed-signal", "section-start", "section-end", "bump", "school", "curve", "curves", "accident", "bike-accident", "other"];
  for (const kind of kinds) {
    for (const rungM of [600, 300, 200, 150]) {
      for (const limit of [undefined, 50, 110]) {
        const s = phraseFor({ feature: { id: "x", kind, lon: 0, lat: 0, limit }, alongM: 0, inM: 0, rungM });
        if ((kind === "bump" && rungM !== 150) || ((kind === "curve" || kind === "curves") && rungM !== 200)) continue;
        if (["section-end", "school", "accident", "bike-accident", "other"].includes(kind) && rungM !== 300) continue;
        if (!["bump", "curve", "curves", "section-end", "school", "accident", "bike-accident", "other"].includes(kind) && rungM !== 600 && rungM !== 300) continue;
        assert.ok(fixed.has(s), `not rendered ahead: ${s}`);
      }
    }
  }
  // The kinds with their own rungs, and every 기상특보 the page can say.
  const more: [Kind, number, number | undefined][] = [
    ["school-zone", 300, 30], ["school-zone", 300, 50], ["school", 300, 30],
    ["incident-crash", 1000, undefined], ["incident-work", 300, undefined], ["incident-other", 1000, undefined], ["rest-area", 2000, undefined],
  ];
  for (const [kind, rungM, limit] of more) {
    const s = phraseFor({ feature: { id: "x", kind, lon: 0, lat: 0, limit }, alongM: 0, inM: 0, rungM });
    assert.ok(fixed.has(s), `not rendered ahead: ${s}`);
  }
  for (const k of ALERT_KINDS) for (const l of ALERT_LEVELS) assert.ok(fixed.has(alertPhrase(k, l)));
  assert.deepEqual(turnRungs(50), [300, 150]);
});

test("a motorway junction's name and way come from any provider's text", async () => {
  const { junctionOf, namedTurnPhrase, laneHint, findMerges } = await import("./highway");
  assert.deepEqual(junctionOf({ text: "신갈JC에서 원주 방면으로 왼쪽 방향 후 영동 고속도로를 따라 3845m 이동" }), { name: "신갈JC", toward: "원주" });
  assert.deepEqual(junctionOf({ text: "신갈분기점에서 '원주, 인천' 방면으로 오른쪽 방향" }), { name: "신갈분기점", toward: "원주" });
  assert.deepEqual(junctionOf({ text: "인천 원주 방면으로 오른쪽 고속도로 진입", name: "신갈JC" }), { name: "신갈JC", toward: "인천" });
  assert.equal(junctionOf({ text: "우회전" }), null);
  assert.equal(namedTurnPhrase("slight-left", 1000, { name: "신갈JC", toward: "원주" }), "일킬로미터 앞 신갈JC에서 원주 방면, 왼쪽 방향입니다");
  assert.equal(namedTurnPhrase("ramp-right", 500, { toward: "용인" }), "오백미터 앞 용인 방면, 오른쪽 출구입니다");
  assert.equal(laneHint("ramp-right"), "오른쪽 차로로 미리 이동하세요");
  assert.equal(laneHint("straight"), null);
  // An entrance at 1 km along a 3 km road: the merge is placed a ramp's length on, and said from 150 m before it.
  const path = Array.from({ length: 31 }, (_, i) => [127, 37 + (i * 100) / 111_320] as [number, number]);
  const merges = findMerges({ provider: "tmap", distanceM: 3000, durationS: 200, path, segments: [], motorways: [[10, 31]],
    guides: [{ at: path[10], text: "서초IC에서 부산 방면으로 오른쪽 고속도로 입구", distanceM: 0, turnType: 101 }] });
  assert.equal(merges.length, 1);
  assert.equal(merges[0].kind, "merge");
  assert.ok(fixedPhrases().includes("잠시 후 합류 구간입니다, 주의하세요"));
  assert.ok(fixedPhrases().includes("오른쪽 차로로 미리 이동하세요"));
});

test("a speed that dips across 70 km/h does not bring the other set's rungs: the set first said from is kept", () => {
  const said = new Set<number>();
  assert.equal(turnSpeech("left", 980, 75, said, ""), "일킬로미터 앞에서 좌회전입니다");
  assert.equal(turnSpeech("left", 480, 72, said, ""), "오백미터 앞에서 좌회전입니다");
  assert.equal(turnSpeech("left", 290, 65, said, ""), null); // not "300미터 앞" on top of "500미터 앞"
  assert.equal(turnSpeech("left", 140, 65, said, ""), "잠시 후 좌회전입니다");
  // And from town: said at 300 m, a burst past 70 km/h adds no "500미터 앞".
  const town = new Set<number>();
  assert.equal(turnSpeech("right", 290, 60, town, ""), "삼백미터 앞에서 우회전입니다");
  assert.equal(turnSpeech("right", 280, 75, town, ""), null);
  assert.equal(turnSpeech("right", 140, 75, town, ""), "잠시 후 우회전입니다");
  assert.equal(turnSpeech("right", 100, 60, town, ""), null);
});
