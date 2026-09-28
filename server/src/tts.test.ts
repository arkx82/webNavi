import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedPhrases, wavOf } from "./tts.js";

test("wavOf writes a 44-byte PCM header round the samples", () => {
  const pcm = Buffer.alloc(480, 0);
  const wav = wavOf(pcm, 24_000);
  assert.equal(wav.length, 524);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt32LE(40), 480);
});

test("the fixed phrases are the ones the warnings say", () => {
  const phrases = fixedPhrases();
  assert.ok(phrases.includes("600미터 앞 과속 단속, 제한 50"));
  assert.ok(phrases.includes("150미터 앞 과속 방지턱"));
  assert.ok(phrases.length > 60 && phrases.length < 150, `${phrases.length}`);
});
