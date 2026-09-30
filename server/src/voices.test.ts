import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLONED_MODEL, nameIn } from "./voices.js";
import { Speaker } from "./tts.js";

test("a made voice's id gives back the name it was made under", () => {
  assert.equal(nameIn("qwen-tts-vc-pf_jun-voice-20260101"), "jun");
  assert.equal(nameIn("qwen-tts-vc-mom-voice-abc"), "mom");
  assert.equal(nameIn("qwen-tts-vc-pf_voice-voice-abc"), null);
  assert.equal(nameIn("Cherry"), null);
});

test("a made voice is spoken by the cloning model, and in the default voice once its allowance is gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-"));
  const asked: [string, string][] = [];
  // A tone that fades into silence, as a sentence ends (a cut-off one would be asked again).
  const pcm = Buffer.alloc(24_000);
  for (let i = 0; i < 10_000; i++) pcm.writeInt16LE(Math.round((i % 2 ? 6000 : -6000) * Math.min(1, (10_000 - i) / 2000)), i * 2);
  const real = globalThis.fetch;
  let clonedSpent = false;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const { model, input } = JSON.parse(init?.body ?? "{}");
    asked.push([model, input.voice]);
    if (model === CLONED_MODEL && clonedSpent) return new Response(`{"code":"AllocationQuota.FreeTierOnly"}`, { status: 403 });
    return new Response(JSON.stringify({ output: { audio: { data: pcm.toString("base64") } } }), { status: 200 });
  }) as typeof fetch;
  try {
    const speaker = new Speaker(() => "key", dir, () => "Sohee");
    const mine = "qwen-tts-vc-pf_jun-voice-1";
    await speaker.say("안내를 시작합니다", mine);
    assert.deepEqual(asked, [[CLONED_MODEL, mine]]);
    asked.length = 0;
    clonedSpent = true;
    await speaker.say("목적지를 변경합니다", mine);
    // Refused by the cloning model, then said by the chain in the default voice.
    assert.deepEqual(asked.map((a) => a[1]), [mine, "Sohee"]);
    assert.ok(speaker.cached("목적지를 변경합니다", "Sohee"));
    assert.equal(speaker.cached("목적지를 변경합니다", mine), null);
  } finally {
    globalThis.fetch = real;
  }
});
