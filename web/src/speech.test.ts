import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedPhrases } from "../../server/src/phrases";
import { EVENTS, spokenGuide, turnRungs, turnSpeech } from "./speech";
import { phraseFor, type Kind } from "./warnings";
import type { Maneuver } from "./maneuver";

test("a left turn is said at 300 m in town, then 잠시 후, once each", () => {
  const said = new Set<number>();
  assert.equal(turnSpeech("left", 450, 50, said, ""), null);
  assert.equal(turnSpeech("left", 290, 50, said, ""), "300미터 앞에서 좌회전입니다");
  assert.equal(turnSpeech("left", 250, 50, said, ""), null);
  assert.equal(turnSpeech("left", 140, 50, said, ""), "잠시 후 좌회전입니다");
  assert.equal(turnSpeech("left", 60, 50, said, ""), null);
});

test("on a fast road the turn comes at 1 km and 500 m", () => {
  const said = new Set<number>();
  assert.equal(turnSpeech("ramp-right", 980, 100, said, ""), "1킬로미터 앞에서 오른쪽 출구입니다");
  assert.equal(turnSpeech("ramp-right", 480, 100, said, ""), "500미터 앞에서 오른쪽 출구입니다");
});

test("a turn first seen close in is only 잠시 후, not every rung in one breath", () => {
  const said = new Set<number>();
  assert.equal(turnSpeech("right", 120, 50, said, ""), "잠시 후 우회전입니다");
  assert.equal(turnSpeech("right", 100, 50, said, ""), null);
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
  assert.deepEqual(turnRungs(50), [300, 150]);
});
