import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Speaker, fixedPhrases, isClipped, pcmOfWav, repairClipped, tailRatio, tighten, tightenWav, wavOf } from "./tts.js";

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
  assert.ok(phrases.includes("600미터 앞에 과속 단속 카메라가 있습니다, 제한 속도 50입니다"));
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

const RATE = 24_000;
const tone = (ms: number, level: (t: number) => number, loud = 12000) => {
  const n = (ms * RATE) / 1000, b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(level(i / n) * loud * Math.sin(i / 3)), i * 2);
  return b;
};
const cutWav = () => wavOf(tone(600, () => 1), RATE);

test("a sentence that fades out has ended; one still sounding in its last 30 ms was cut off", () => {
  // As tighten() keeps one: the word fades, then a little silence.
  const faded = wavOf(Buffer.concat([tone(600, () => 1), tone(150, (t) => 1 - t), Buffer.alloc((RATE / 10) * 2)]), RATE);
  assert.ok(!isClipped(faded), `${tailRatio(faded)}`);
  assert.ok(isClipped(cutWav()), `${tailRatio(cutWav())}`);
});

test("a quiet take whose tail is what tighten() calls a pause is not cut off, whatever the ratio says", () => {
  // Peak 2000, tail 200: a tenth of the peak, yet under the pause floor of 300.
  const quiet = wavOf(Buffer.concat([tone(600, () => 1, 2000), tone(100, () => 1, 200)]), RATE);
  assert.ok(tailRatio(quiet) > 0.05, `${tailRatio(quiet)}`);
  assert.ok(!isClipped(quiet));
  const loudTail = wavOf(Buffer.concat([tone(600, () => 1, 20000), tone(100, () => 1, 2000)]), RATE);
  assert.ok(isClipped(loudTail), "a tail that is loud in both senses still is");
});

/** A speaker whose model is [render], no DashScope: what it says, in order, is [asked]. */
function fakeSpeaker(dir: string, render: (text: string) => Buffer, asked: string[] = []) {
  const speaker = new Speaker(() => "key", dir, () => "Cherry");
  (speaker as unknown as { render: (key: string, tier: unknown, text: string) => Promise<Buffer> }).render = async (_k, _t, text) => { asked.push(text); return render(text); };
  return speaker;
}

test("a sentence cut off is asked once more with its full stop, and the ledger is told once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webnavi-tts-"));
  const asked: string[] = [];
  const speaker = fakeSpeaker(dir, () => cutWav(), asked);
  const repaired: string[] = [];
  speaker.ledger = { made: () => {}, used: () => {}, repaired: (f) => repaired.push(f) };
  await speaker.say("제한 속도 50");
  assert.deepEqual(asked, ["제한 속도 50", "제한 속도 50."]);
  assert.deepEqual(repaired, [speaker.fileFor("제한 속도 50")]);
  await speaker.say("제한 속도 50");
  assert.equal(asked.length, 2, "served from disk after");
  assert.equal(repaired.length, 1);
});

test("the start-up repair leaves a sentence alone that was already made again once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webnavi-tts-"));
  const asked: string[] = [];
  const speaker = fakeSpeaker(dir, () => cutWav(), asked);
  writeFileSync(join(dir, "done.wav"), cutWav());
  writeFileSync(join(dir, "fresh.wav"), cutWav());
  writeFileSync(join(dir, "unknown.wav"), cutWav());
  const rows: Record<string, { text: string; voice: string; repaired: boolean }> = {
    "done.wav": { text: "이미 고친 문장", voice: "Cherry", repaired: true },
    "fresh.wav": { text: "아직인 문장", voice: "Cherry", repaired: false },
  };
  const forgotten: string[] = [];
  const r = await repairClipped(speaker, dir, (f) => rows[f] ?? null, () => true, (f) => forgotten.push(f));
  assert.deepEqual(r, { checked: 3, clipped: 3, remade: 1, dropped: 1, kept: 1 });
  assert.deepEqual(forgotten.sort(), ["fresh.wav", "unknown.wav"]);
  assert.deepEqual(asked, ["아직인 문장", "아직인 문장."]);
  const left = readdirSync(dir).filter((f) => f.endsWith(".wav")).sort();
  assert.ok(left.includes("done.wav"), left.join());
  assert.ok(!left.includes("unknown.wav"));
  assert.ok(left.includes(`${speaker.fileFor("아직인 문장").split("/").pop()}`));
});
