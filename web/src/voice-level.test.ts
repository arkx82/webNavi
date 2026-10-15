import { test } from "node:test";
import assert from "node:assert/strict";
import { levelGain } from "./voice";

test("each sentence to one loudness: a quiet one raised, a loud one held under its peak, silence left alone", () => {
  const tone = (amp: number) => Float32Array.from({ length: 24_000 }, (_, i) => (i < 4000 ? 0 : amp * Math.sin(i / 5)));
  const quiet = levelGain(tone(0.1)); // RMS about 0.07
  assert.ok(quiet > 2.6 && quiet < 3, `${quiet}`);
  const loud = levelGain(tone(0.85));
  assert.ok(loud * 0.85 <= 1 + 1e-9, `peak held: ${loud}`);
  assert.equal(levelGain(new Float32Array(100)), 1);
  // A whisper is not blown up past 4×.
  assert.equal(levelGain(tone(0.02)), 4);
});
