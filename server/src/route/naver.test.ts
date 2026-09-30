import { test } from "node:test";
import assert from "node:assert/strict";
import { motorwaysByGuides } from "./naver.js";

test("a motorway runs from its entrance to the exit, or to the first town turn", () => {
  const guides = [
    { pointIndex: 10, instructions: "한남IC에서 '부산' 방면으로 오른쪽 도로 주행" },
    { pointIndex: 20, instructions: "'부산, 대전, 양재IC' 방면으로 고속도로 진입" },
    { pointIndex: 90, instructions: "신갈분기점에서 '원주' 방면으로 직진" },
    { pointIndex: 150, instructions: "'만덕센텀고속화도로, 해운대, 교대교차로' 방면으로 왼쪽 방향" },
    { pointIndex: 300, instructions: "동수원IC에서 '동수원' 방면으로 오른쪽 고속도로 출구" },
    { pointIndex: 320, instructions: "'해운대, 광안대교' 방면으로 왼쪽 도시고속도로 진입" },
    { pointIndex: 400, instructions: "올림픽동산삼거리에서 '해운대' 방면으로 오른쪽 방향" },
    { pointIndex: 420, instructions: "목적지" },
  ];
  assert.deepEqual(motorwaysByGuides(guides, 430), [[20, 300], [320, 400]]);
  assert.deepEqual(motorwaysByGuides(guides.slice(0, 3), 430), [[20, 429]]);
});
