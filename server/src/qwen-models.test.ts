import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAIN, SpentBook, saysSpent, voiceOn } from "./qwen-models.js";
import { Speaker, wavOf } from "./tts.js";

test("Model Studio's free-tier refusal is told from any other", () => {
  assert.ok(saysSpent(`{"code":"AllocationQuota.FreeTierOnly","message":"The free tier of the model has been exhausted."}`));
  assert.ok(!saysSpent(`{"code":"InvalidApiKey"}`));
});

test("a voice the old snapshot lacks is spoken by the plainest one of the same sex", () => {
  const old = CHAIN.find((t) => !t.full)!;
  assert.equal(voiceOn(old, "Cherry"), "Cherry");
  assert.equal(voiceOn(old, "Serena"), "Cherry");
  assert.equal(voiceOn(old, "Dylan"), "Ethan");
  assert.equal(voiceOn(CHAIN[0], "Serena"), "Serena");
});

test("a spent model is passed over for the next, remembered, and other refusals are not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-"));
  const asked: string[] = [];
  const real = globalThis.fetch;
  const pcm = Buffer.alloc(24_000, 0).fill(40, 0, 24_000); // half a second of a quiet tone
  for (let i = 0; i < 12_000; i++) pcm.writeInt16LE(i % 2 ? 6000 : -6000, i * 2);
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const model = JSON.parse(init?.body ?? "{}").model as string;
    asked.push(model);
    if (model === CHAIN[0].model) return new Response(`{"code":"AllocationQuota.FreeTierOnly"}`, { status: 403 });
    return new Response(JSON.stringify({ output: { audio: { data: pcm.toString("base64") } } }), { status: 200 });
  }) as typeof fetch;
  try {
    const speaker = new Speaker(() => "key", dir);
    const wav = await speaker.say("안내를 시작합니다");
    assert.ok(wav.length > 44);
    assert.deepEqual(asked, [CHAIN[0].model, CHAIN[1].model]);
    // A new speaker on the same folder remembers, and goes straight to the second.
    asked.length = 0;
    await new Speaker(() => "key", dir).say("목적지를 변경합니다");
    assert.deepEqual(asked, [CHAIN[1].model]);
    assert.equal(new SpentBook(dir).current(), CHAIN[1].model);
    // A refusal that is not about the allowance is the answer, not a reason to move on.
    globalThis.fetch = (async () => new Response(`{"code":"InvalidParameter"}`, { status: 400 })) as unknown as typeof fetch;
    await assert.rejects(new Speaker(() => "key", dir).say("다른 문장"), /InvalidParameter/);
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(wavOf(Buffer.alloc(2), 24_000).length === 46);
});
