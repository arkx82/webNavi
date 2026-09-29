import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedPhrases, pcmOfWav, tighten, tightenWav, wavOf } from "./tts.js";

test("wavOf writes a 44-byte PCM header round the samples", () => {
  const pcm = Buffer.alloc(480, 0);
  const wav = wavOf(pcm, 24_000);
  assert.equal(wav.length, 524);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt32LE(40), 480);
});

test("the fixed phrases are the car apps' sentences, a closed set", () => {
  const phrases = fixedPhrases();
  assert.ok(phrases.includes("600미터 앞 과속 단속, 제한 속도 50"));
  assert.ok(phrases.includes("300미터 앞에서 좌회전입니다"));
  assert.ok(phrases.includes("잠시 후 오른쪽 방향입니다"));
  assert.ok(phrases.includes("1킬로미터 앞에서 오른쪽 출구입니다"));
  assert.ok(phrases.length > 90 && phrases.length < 200, `${phrases.length}`);
});

/** 24 kHz samples: [ms of tone, ms of silence, …]. */
function speech(...parts: number[]): Buffer {
  const out: number[] = [];
  parts.forEach((ms, i) => {
    for (let k = 0; k < (ms * 24_000) / 1000; k++) out.push(i % 2 === 0 ? Math.round(8000 * Math.sin(k / 3)) : 4);
  });
  const b = Buffer.alloc(out.length * 2);
  out.forEach((v, k) => b.writeInt16LE(v, k * 2));
  return b;
}
const ms = (pcm: Buffer) => Math.round((pcm.length / 2 / 24_000) * 1000);

test("long pauses inside are cut to the maximum, short ones and the words are kept", () => {
  // 200 ms lead silence, word, 500 ms pause, word, 100 ms pause, word, 400 ms tail.
  const pcm = speech(0, 200, 300, 500, 300, 100, 300, 400).subarray(0);
  const out = tighten(pcm, 24_000);
  // 30 lead + 300 + 180 + 300 + 100 + 300 + 120 tail.
  assert.ok(Math.abs(ms(out) - 1330) <= 20, `${ms(out)} ms`);
});

test("a header that claims 2 GB is read to the end of the file, and written back true", () => {
  const pcm = speech(0, 50, 200, 50);
  const lying = wavOf(pcm, 24_000);
  lying.writeUInt32LE(2147483547, 40);
  assert.equal(pcmOfWav(lying)!.pcm.length, pcm.length);
  const fixed = tightenWav(lying);
  assert.equal(fixed.readUInt32LE(40), fixed.length - 44);
});
