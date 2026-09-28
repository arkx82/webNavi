import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Words into sound, once each. A phrase is rendered by Qwen3-TTS through
 * DashScope the first time it is asked for and kept as a WAV under the
 * hash of (voice, text); the fixed phrases are rendered ahead of time by
 * `prerender.ts`, and every guide text a provider ever sends becomes
 * fixed after its first trip.
 */
const BASE = "https://dashscope-intl.aliyuncs.com";
const MODEL = "qwen3-tts-flash";

export class Speaker {
  constructor(private key: () => string | undefined, private dir: string, private voiceOf: () => string | undefined = () => undefined) {
    mkdirSync(dir, { recursive: true });
  }

  get ready() {
    return !!this.key();
  }

  get voice() {
    return this.voiceOf() || "Cherry";
  }

  fileFor(text: string): string {
    const hash = createHash("sha1").update(`${this.voice}\n${text}`).digest("hex").slice(0, 20);
    return join(this.dir, `${hash}.wav`);
  }

  cached(text: string): Buffer | null {
    const file = this.fileFor(text);
    return existsSync(file) ? readFileSync(file) : null;
  }

  /** The WAV for [text], from disk or from the service. */
  async say(text: string): Promise<Buffer> {
    const had = this.cached(text);
    if (had) return had;
    const key = this.key();
    if (!key) throw new Error("tts has no key on this server");
    const answer = await fetch(`${BASE}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: { text, voice: this.voice, language_type: "Korean" } }),
    });
    if (!answer.ok) throw new Error(`dashscope ${answer.status}: ${(await answer.text()).slice(0, 300)}`);
    const body = (await answer.json()) as { output?: { audio?: { url?: string; data?: string } }; message?: string };
    let wav: Buffer;
    if (body.output?.audio?.url) {
      const sound = await fetch(body.output.audio.url);
      if (!sound.ok) throw new Error(`audio url ${sound.status}`);
      wav = Buffer.from(await sound.arrayBuffer());
    } else if (body.output?.audio?.data) {
      // Raw 24 kHz mono 16-bit samples, as the streaming form gives them.
      wav = wavOf(Buffer.from(body.output.audio.data, "base64"), 24_000);
    } else {
      throw new Error(`dashscope: no audio (${body.message ?? "?"})`);
    }
    writeFileSync(this.fileFor(text), wav);
    return wav;
  }
}

/** A WAV header round [pcm]: 16-bit mono at [rate]. */
export function wavOf(pcm: Buffer, rate: number): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/**
 * The phrases known before any trip: every warning at every distance rung,
 * with every speed limit the roads post. Roughly a hundred, rendered once.
 */
/** Every fixed phrase into the cache; how many were made and how many were there. */
export async function prerender(speaker: Speaker): Promise<{ made: number; had: number }> {
  let made = 0, had = 0;
  for (const text of fixedPhrases()) {
    if (speaker.cached(text)) { had++; continue; }
    await speaker.say(text);
    made++;
  }
  return { made, had };
}

export function fixedPhrases(): string[] {
  const out = new Set<string>();
  const limits = [30, 40, 50, 60, 70, 80, 90, 100, 110];
  const far = ["600미터 앞", "300미터 앞"];
  for (const d of far) {
    out.add(`${d} 과속 단속`);
    out.add(`${d} 신호 단속`);
    out.add(`${d} 신호 과속 단속`);
    out.add(`${d} 구간 단속 시작`);
    out.add(`${d} 주의`);
    for (const l of limits) {
      out.add(`${d} 과속 단속, 제한 ${l}`);
      out.add(`${d} 신호 과속 단속, 제한 ${l}`);
      out.add(`${d} 구간 단속 시작, 제한 ${l}`);
    }
  }
  out.add("300미터 앞 구간 단속 끝");
  out.add("300미터 앞 어린이 보호구역");
  out.add("150미터 앞 과속 방지턱");
  out.add("200미터 앞 급커브");
  for (const s of ["경로를 벗어나 다시 찾습니다", "더 빠른 길로 안내합니다", "목적지에 도착했습니다", "안내를 시작합니다", "GPS 신호가 약합니다"]) out.add(s);
  return [...out];
}
