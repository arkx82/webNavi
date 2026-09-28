import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "./settings.js";

const dir = () => mkdtempSync(join(tmpdir(), "nav-settings-"));

test("what is saved comes back after a restart, and is not on disk in the clear", () => {
  const d = dir();
  const a = new Settings(d, {});
  a.set({ tmapAppKey: "abcd1234SECRET", ttsVoice: "Ethan" });
  const raw = readFileSync(join(d, "settings.enc"), "utf8");
  assert.ok(!raw.includes("SECRET"));
  assert.ok(raw.startsWith("v1."));
  assert.equal(statSync(join(d, "master.key")).mode & 0o777, 0o600);
  const b = new Settings(d, {});
  assert.equal(b.get("tmapAppKey"), "abcd1234SECRET");
  assert.equal(b.get("ttsVoice"), "Ethan");
  assert.equal(b.masked().tmapAppKey.hint, "…CRET");
  assert.equal(b.masked().tmapAppKey.from, "saved");
});

test("the environment fills what the page left unset, and an empty save clears back to it", () => {
  const s = new Settings(dir(), { KAKAO_REST_KEY: "fromenv" });
  assert.equal(s.get("kakaoRestKey"), "fromenv");
  assert.equal(s.masked().kakaoRestKey.from, "env");
  s.set({ kakaoRestKey: "typed" });
  assert.equal(s.get("kakaoRestKey"), "typed");
  s.set({ kakaoRestKey: "" });
  assert.equal(s.get("kakaoRestKey"), "fromenv");
  assert.equal(s.get("naverClientId"), undefined);
});

test("the password is checked against a scrypt hash, and tokens verify only unaltered", () => {
  const s = new Settings(dir(), {});
  assert.equal(s.hasPassword, false);
  s.setPassword("correct horse");
  assert.ok(s.hasPassword);
  assert.ok(s.checkPassword("correct horse"));
  assert.ok(!s.checkPassword("correct horsE"));
  const sig = s.sign("exp=123");
  assert.ok(s.verify("exp=123", sig));
  assert.ok(!s.verify("exp=124", sig));
});
