import { test } from "node:test";
import assert from "node:assert/strict";
import { labelOf, toward } from "./places";

test("집 and 회사 called as the driver renamed them, 집 and 회사 otherwise", () => {
  const s = { home: null, work: null, favourites: [] };
  assert.equal(labelOf(s, "work"), "회사");
  assert.equal(labelOf({ ...s, labels: { work: "사무실" } }, "work"), "사무실");
  assert.equal(labelOf({ ...s, labels: { work: "  " } }, "work"), "회사");
});

test("the particle (으)로 as Korean reads it", () => {
  assert.equal(toward("집"), "집으로");
  assert.equal(toward("회사"), "회사로");
  assert.equal(toward("사무실"), "사무실로");
  assert.equal(toward("학교"), "학교로");
  assert.equal(toward("본가"), "본가로");
  assert.equal(toward("헬스장"), "헬스장으로");
  assert.equal(toward("GYM"), "GYM(으)로");
});
