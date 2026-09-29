import { test } from "node:test";
import assert from "node:assert/strict";
import { chosung, matches } from "./find";
import { isoSeconds } from "./tidal-time";

test("a playlist is found by its words or by its initial consonants", () => {
  assert.equal(chosung("드라이브 Mix"), "ㄷㄹㅇㅂ Mix");
  assert.ok(matches("드라이브 Mix", "ㄷㄹㅇㅂ"));
  assert.ok(matches("드라이브 Mix", "이브 m"));
  assert.ok(matches("Jazz at Night", "jazz"));
  assert.ok(!matches("Jazz at Night", "ㄷㄹ"));
  assert.ok(matches("anything", ""));
});

test("TIDAL's ISO 8601 lengths come out in seconds", () => {
  assert.equal(isoSeconds("PT3M21S"), 201);
  assert.equal(isoSeconds("PT1H2M3.5S"), 3723.5);
  assert.equal(isoSeconds("PT45S"), 45);
  assert.equal(isoSeconds(undefined), undefined);
});
