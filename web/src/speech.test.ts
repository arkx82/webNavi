import { test } from "node:test";
import assert from "node:assert/strict";
import { ALERT_KINDS, ALERT_LEVELS, ENTRY_PHRASES, THEN_M, alertPhrase, fixedPhrases, koreanNumbers, roundaboutPhrase, thenPhrase, turnPhrase } from "../../server/src/phrases";
import { EVENTS, facilityOf, roundaboutHour, spokenGuide, turnRungs, turnSay, turnSpeech } from "./speech";
import { phraseFor, type Kind } from "./warnings";
import type { Maneuver } from "./maneuver";

/** What is said for one guide on the way in, 10 m a step from 2.2 km: [metres out, sentence]. */
function approach(m: Maneuver, road: "town" | "fast", text = ""): [number, string][] {
  const said = new Set<number>();
  const out: [number, string][] = [];
  for (let inM = 2200; inM >= 0; inM -= 10) {
    const s = turnSpeech(m, inM, road, said, text);
    if (s) out.push([inM, s]);
  }
  return out;
}

test("in town a turn is said as TMAP does: 1 km, 500 m, 300 m, then 잠시 후 within 130 m, each once", () => {
  assert.deepEqual(approach("left", "town"), [
    [1050, "일킬로미터 앞에서 좌회전입니다"], [550, "오백미터 앞에서 좌회전입니다"], [350, "삼백미터 앞에서 좌회전입니다"], [130, "잠시 후 좌회전입니다"],
  ]);
});

test("on a motorway or 도시고속도로: 2 km, 1 km, 600 m, then 잠시 후 within 220 m", () => {
  assert.deepEqual(approach("ramp-right", "fast"), [
    [2050, "이킬로미터 앞에서 오른쪽 출구입니다"], [1050, "일킬로미터 앞에서 오른쪽 출구입니다"], [690, "육백미터 앞에서 오른쪽 출구입니다"], [220, "잠시 후 오른쪽 출구입니다"],
  ]);
});

test("a rung whose window was passed unsaid is not said late: no 500미터 at 400 m", () => {
  const town = new Set<number>();
  assert.equal(turnSpeech("right", 400, "town", town, ""), null);
  assert.equal(turnSpeech("right", 340, "town", town, ""), "삼백미터 앞에서 우회전입니다");
  const late = new Set<number>();
  assert.equal(turnSpeech("right", 190, "town", late, ""), null);
  assert.equal(turnSpeech("right", 125, "town", late, ""), "잠시 후 우회전입니다");
  const fast = new Set<number>();
  assert.equal(turnSpeech("right", 400, "fast", fast, ""), null);
  assert.equal(turnSpeech("right", 215, "fast", fast, ""), "잠시 후 우회전입니다");
  assert.equal(turnSpeech("right", 150, "fast", fast, ""), null);
});

test("a 지하차도 is said twice: the road's last far rung and 잠시 후", () => {
  assert.deepEqual(approach("other", "fast", "지하차도 진입").map(([, t]) => t), ["육백미터 앞에서 지하차도 진입입니다", "잠시 후 지하차도 진입입니다"]);
  assert.deepEqual(approach("other", "town", "지하차도 진입").map(([, t]) => t), ["삼백미터 앞에서 지하차도 진입입니다", "잠시 후 지하차도 진입입니다"]);
});



test("a turn first seen close in is only 잠시 후, not every rung in one breath", () => {
  const said = new Set<number>();
  assert.equal(turnSpeech("right", 120, "town", said, ""), "잠시 후 우회전입니다");
  assert.equal(turnSpeech("right", 100, "town", said, ""), null);
});


test("straight on and the arrival are said once, close in", () => {
  assert.equal(turnSpeech("straight", 290, "town", new Set(), ""), null);
  // 직진 at a plain crossroads is not said; where the words name a choice it is.
  assert.equal(turnSpeech("straight", 120, "town", new Set(), ""), null);
  assert.equal(turnSpeech("straight", 120, "town", new Set(), "직진"), null);
  assert.equal(turnSpeech("straight", 120, "town", new Set(), "직진 방향 (성수대교 방면)"), "잠시 후 직진입니다");
  assert.equal(turnSpeech("straight", 120, "town", new Set(), "지하차도 진입"), "잠시 후 지하차도 진입입니다");
  assert.equal(turnSpeech("arrive", 120, "town", new Set(), ""), EVENTS.nearGoal);
});

test("provider text is made sayable for a manoeuvre with no word of its own", () => {
  assert.equal(spokenGuide("선릉역에서 강남구청 방면으로 좌회전 후 선릉로를 따라 15m 이동"), "선릉역에서 강남구청 방면으로 좌회전");
  assert.equal(spokenGuide("강남역에서 '역삼역' 방면으로 좌회전"), "강남역에서 역삼역 방면으로 좌회전");
  assert.equal(turnSpeech("other", 120, "town", new Set(), "지정체 구간 진입"), "잠시 후 지정체 구간 진입입니다");
  // 서울양양's toll gate, said once close in as any toll gate, not four times as "… 원톨링 진입" cut off (2026-10-03).
  assert.equal(turnSpeech("other", 1000, "fast", new Set(), "원톨링 진입"), null);
  assert.equal(turnSpeech("other", 200, "fast", new Set(), "원톨링 진입"), "잠시 후 톨게이트입니다");
  assert.equal(turnSpeech("other", 120, "town", new Set(), "톨게이트 통과"), "잠시 후 톨게이트입니다");
});

test("every sentence the page can say from the vocabulary is one the server renders ahead", () => {
  const fixed = new Set(fixedPhrases());
  const turns: Maneuver[] = ["straight", "left", "right", "slight-left", "slight-right", "sharp-left", "sharp-right", "uturn", "ramp-left", "ramp-right", "roundabout", "arrive"];
  for (const speed of ["town", "fast"] as const) {
    for (const m of turns) {
      for (let inM = 2100; inM >= 0; inM -= 10) {
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
  // Every far rung of both roads has its sentences.
  for (const road of ["town", "fast"] as const) for (const r of turnRungs(road)) assert.ok(fixed.has(turnPhrase("left", r.m)), `${road} ${r.m}`);
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

test("a motorway junction's kind comes from the road: 진입 at a JC is a fork, not an entrance from the side", async () => {
  const { junctionKind, findMerges } = await import("./highway");
  const { metres } = await import("./geo");
  // On the motorway before and after: a fork, whatever the words (Kakao writes 진입 at 신갈JC).
  assert.equal(junctionKind("인천 원주 방면으로 오른쪽 고속도로 진입", { before: true, after: true }), "fork");
  assert.equal(junctionKind("남구리IC 방면으로 오른쪽 방향", { before: true, after: true }), "fork");
  // Off the motorway onto it: an entrance; off it: an exit, and 출구 says so even where the ramp still counts as one.
  assert.equal(junctionKind("부산 방면으로 오른쪽 고속도로 진입", { before: false, after: true }), "enter");
  assert.equal(junctionKind("오른쪽 방향", { before: true, after: false }), "exit");
  assert.equal(junctionKind("용인 방면으로 오른쪽 고속도로 출구", { before: true, after: true }), "exit");
  // The road not saying: only 입구 is an entrance; 진입 is the fork, whose picture is right either way.
  assert.equal(junctionKind("장수IC에서 전방 고속도로 입구", null), "enter");
  assert.equal(junctionKind("인천 원주 방면으로 오른쪽 고속도로 진입", null), "fork");
  assert.equal(junctionKind("오른쪽 방향", { before: false, after: false }), "fork");
  // The merge after a JC branch written as 진입 is a link road's length on (450 m), not a ramp's (300 m).
  const path = Array.from({ length: 31 }, (_, i) => [127, 37 + (i * 100) / 111_320] as [number, number]);
  const merges = findMerges({ provider: "kakao", distanceM: 3000, durationS: 200, path, segments: [], motorways: [[0, 31]],
    guides: [{ at: path[10], text: "인천 원주 방면으로 오른쪽 고속도로 진입", name: "신갈JC", distanceM: 0, turnType: 49 }] });
  assert.equal(merges.length, 1);
  assert.ok(Math.abs(metres(path[10][0], path[10][1], merges[0].lon, merges[0].lat) - 450) < 5);
});


test("Kakao's 12시 방향 at each IC is not said; a straight on that names its way still is", () => {
  assert.equal(turnSpeech("straight", 120, "fast", new Set(), "12시 방향"), null);
  assert.equal(turnSpeech("straight", 120, "town", new Set(), "성산대교 일산 방면으로 직진"), "잠시 후 직진입니다");
});

test("into a 지하차도 or beside a 고가차도: said as such, with the side", () => {
  const said = new Set<number>();
  assert.equal(facilityOf("미사지하차도에서 '광주, 양평, 팔당댐' 방면으로 왼쪽 지하차도 진입")?.side, "왼쪽");
  assert.equal(turnSpeech("slight-left", 290, "town", said, "미사지하차도에서 '광주, 양평, 팔당댐' 방면으로 왼쪽 지하차도 진입"), "삼백미터 앞에서 왼쪽 지하차도 진입입니다");
  assert.equal(turnSpeech("slight-left", 120, "town", new Set(), "마포대교북단에서 '일산, 성산대교' 방면으로 고가차도 왼쪽 옆길"), "잠시 후 고가차도 왼쪽 옆길입니다");
  // The place it is at is not the action: "조정지하차도에서 … 지하차도 진입".
  assert.deepEqual(facilityOf("조정지하차도에서 '광주' 방면으로 지하차도 진입"), { kind: "지하차도", how: "진입" });
  assert.equal(turnSpeech("other", 120, "town", new Set(), "지하차도 진입"), "잠시 후 지하차도 진입입니다");
  assert.equal(facilityOf("응봉교에서 성동교 방면으로 오른쪽 방향"), null);
  // Its own words if the facility sentence cannot be had.
  assert.equal(turnSay("slight-left", 120, "town", new Set(), "고가차도 왼쪽 옆길")?.fallback, "잠시 후 왼쪽 방향입니다");
});

test("a toll gate is said once, close in, without its fare", () => {
  const said = new Set<number>();
  assert.equal(turnSpeech("other", 480, "fast", said, "판교톨게이트 (통행료 1,000원)"), null);
  assert.equal(turnSpeech("other", 210, "fast", said, "판교톨게이트 (통행료 1,000원)"), "잠시 후 톨게이트입니다");
  assert.equal(turnSpeech("other", 120, "town", new Set(), "하이패스 전용 톨게이트"), "잠시 후 하이패스 전용 톨게이트입니다");
});


test("the new sentences are rendered ahead too", () => {
  const fixed = new Set(fixedPhrases());
  for (const text of ["지하차도 진입", "왼쪽 지하차도 진입", "고가도로 옆길", "고가차도 오른쪽 옆길", "판교톨게이트", "하이패스 전용 톨게이트"]) {
    for (const speed of ["town", "fast"] as const) for (let inM = 2100; inM >= 0; inM -= 10) {
      const s = turnSpeech("other", inM, speed, new Set(), text);
      if (s) assert.ok(fixed.has(s), `not rendered ahead: ${s}`);
    }
  }
  for (const t of ["left", "right", "uturn", "slight-right"] as const) {
    assert.ok(fixed.has(thenPhrase(t, null)));
    for (const g of THEN_M) assert.ok(fixed.has(thenPhrase(t, g)), thenPhrase(t, g));
  }
});

test("onto a motorway straight on: one fixed sentence close in, not the provider's list of places", () => {
  const said = new Set<number>();
  assert.equal(turnSpeech("other", 990, "fast", said, "하남시청,팔당대교 덕소삼패,춘천 방면으로 고속도로 입구"), null);
  assert.equal(turnSpeech("other", 210, "fast", said, "하남시청,팔당대교 덕소삼패,춘천 방면으로 고속도로 입구"), "잠시 후 고속도로 진입입니다");
  assert.equal(turnSpeech("straight", 120, "town", new Set(), "한남IC에서 전방 고속도로 입구 후 경부 고속도로를 따라 15222m 이동"), "잠시 후 고속도로 진입입니다");
  assert.equal(turnSpeech("other", 120, "town", new Set(), "'강변북로' 방면으로 도시고속도로 진입"), "잠시 후 도시고속도로 진입입니다");
  for (const t of Object.values(ENTRY_PHRASES)) assert.ok(new Set(fixedPhrases()).has(t));
});


test("a roundabout says its way out as a clock hour at 300 m and 잠시 후", () => {
  const text = "신북교차로에서 '양구, 오음' 방면으로 회전교차로에서 2시 방향";
  assert.deepEqual(approach("roundabout", "town", text).map(([, t]) => t), [
    "일킬로미터 앞에서 회전교차로입니다", "오백미터 앞에서 회전교차로입니다", "삼백미터 앞 회전교차로에서 두 시 방향입니다", "잠시 후 회전교차로에서 두 시 방향입니다",
  ]);
  assert.equal(roundaboutHour("송청교차로에서 '양양, 인제' 방면으로 회전교차로에서 직진"), 12);
  assert.equal(turnSpeech("roundabout", 120, "town", new Set(), "회전교차로에서 12시 방향"), "잠시 후 회전교차로에서 직진입니다");
  assert.equal(roundaboutHour("왼쪽 방향"), null);
  assert.equal(roundaboutPhrase(11, 150), "잠시 후 회전교차로에서 열한 시 방향입니다");
  assert.equal(koreanNumbers("회전교차로에서 오른쪽 2시 방향, 300m"), "회전교차로에서 오른쪽 두 시 방향, 삼백m");
  const fixed = new Set(fixedPhrases());
  for (let h = 1; h <= 12; h++) for (const r of [300, 150]) assert.ok(fixed.has(roundaboutPhrase(h, r)));
});
