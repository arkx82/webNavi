import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAWN_OUT_MS, firstSyllableMs, wavOf } from "./tts.js";

/** A made-up sentence: syllables of [ms] each, a 60 ms dip between them, at 24 kHz. */
function speech(syllables: number[]): Buffer {
  const rate = 24_000, parts: number[] = [];
  const tone = (ms: number, amp: number) => { for (let i = 0; i < (rate * ms) / 1000; i++) parts.push(Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / rate))); };
  tone(80, 0);
  syllables.forEach((ms, k) => { tone(ms, 9000); if (k < syllables.length - 1) tone(60, 600); });
  tone(80, 0);
  const pcm = Buffer.alloc(parts.length * 2);
  parts.forEach((v, i) => pcm.writeInt16LE(v, i * 2));
  return wavOf(pcm, rate);
}

test("a sentence's first syllable is measured to the first dip: a plain one is short, a drawn-out one long", () => {
  const plain = firstSyllableMs(speech([180, 200, 220, 200]));
  const drawn = firstSyllableMs(speech([480, 200, 220, 200]));
  assert.ok(plain < DRAWN_OUT_MS, `plain ${plain}`);
  assert.ok(drawn > DRAWN_OUT_MS, `drawn out ${drawn}`);
  assert.ok(Math.abs(plain - 200) <= 60, `plain ${plain}`);
  assert.ok(Math.abs(drawn - 500) <= 60, `drawn out ${drawn}`);
});
