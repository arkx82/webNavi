import { test } from "node:test";
import assert from "node:assert/strict";

// A fake Web Audio and fetch: a sentence with "멈춘" in it never gets its sound (a request hung on a weak link); the
// others come at once and play for 0.2 s.
class Param { value = 1; setTargetAtTime() {} cancelScheduledValues() {} setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {} }
class Node { gain = new Param(); threshold = new Param(); knee = new Param(); ratio = new Param(); attack = new Param(); release = new Param(); connect(n: unknown) { return n; } start() {} stop() {} }
class Src extends Node { buffer: { duration: number } = { duration: 0 }; onended: (() => void) | null = null; start() { setTimeout(() => this.onended?.(), this.buffer.duration * 1000); } }
class Ctx {
  state = "running"; currentTime = 0; destination = new Node();
  createGain() { return new Node(); } createDynamicsCompressor() { return new Node(); } createConstantSource() { return new Node(); } createBufferSource() { return new Src(); }
  async resume() {}
  async decodeAudioData() { return { sampleRate: 100, length: 20, duration: 0.2, numberOfChannels: 1, getChannelData: () => new Float32Array(20) }; }
  createBuffer(_c: number, len: number, rate: number) { return { duration: len / rate, copyToChannel() {}, getChannelData: () => new Float32Array(len) }; }
}
(globalThis as Record<string, unknown>).window = { AudioContext: Ctx };
(globalThis as Record<string, unknown>).fetch = (url: string) => decodeURIComponent(url).includes("멈춘")
  ? new Promise(() => {})
  : Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });

test("a sentence whose sound never comes is let go when its moment passes, and a turn behind a stuck warning is said", async () => {
  const { Voice } = await import("./voice");
  const v = new Voice();
  const said: string[] = [], late: string[] = [];
  v.onSaid = (text) => said.push(text);
  v.onLate = (text) => late.push(text);
  // A turn whose sound hangs, true for 1 s: let go then, and the warning behind it said.
  v.say("멈춘 교차로에서 우회전", undefined, { turn: true, withinS: 1 });
  v.say("과속 단속 구간입니다");
  await new Promise((r) => setTimeout(r, 1800));
  assert.deepEqual(late, ["멈춘 교차로에서 우회전"]);
  assert.deepEqual(said, ["과속 단속 구간입니다"]);
  // A warning whose sound hangs, and a turn queued behind it 2 s on (after the first look at GIVE_WAY_MS): the turn said.
  v.say("멈춘 경고입니다");
  await new Promise((r) => setTimeout(r, 2000));
  v.say("잠시 후 우회전입니다", undefined, { turn: true });
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(late.includes("멈춘 경고입니다"), late.join(", "));
  assert.ok(said.includes("잠시 후 우회전입니다"), said.join(", "));
  assert.equal(v.busy, false);
});
