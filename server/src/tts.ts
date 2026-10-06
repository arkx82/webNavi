import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fixedPhrases } from "./phrases.js";
import { ALL_SPENT, CHAIN, SpentBook, SpentError, realtime, saysSpent, voiceOn, type Tier } from "./qwen-models.js";
import { CLONED_MODEL } from "./voices.js";

/** A voice the owner made (an id from the cloning model), not one of Qwen's own. */
export const isMadeVoice = (voice: string) => /^qwen-tts-vc-/.test(voice);
const CLONED_TIER: Tier = { model: CLONED_MODEL, realtime: false, full: true };

export { fixedPhrases };

/**
 * Words into sound, once each. A phrase is rendered by Qwen3-TTS through
 * DashScope the first time it is asked for and kept as a WAV under the
 * hash of (voice, text); the fixed phrases are rendered ahead of time by
 * `prerender.ts` (and by the server on start), and anything else becomes
 * fixed after its first use.
 *
 * What the model gives is tightened before it is kept (tighten): Qwen3-TTS
 * pauses 0.3–0.5 s mid-sentence ("500미터 앞 … 테헤란로"), and trails
 * silence, which in a car sounds like the voice breaking up.
 */
const BASE = "https://dashscope-intl.aliyuncs.com";
/** How long one render may take before it is given up: a service that never answers must not hold /api/tts for ever. */
const RENDER_TIMEOUT_MS = 30_000;
/** Renders asked of Model Studio at once; the rest wait their turn. */
const RENDERS_AT_ONCE = 2;
/** A render refused for the rate is tried again after these waits. */
const THROTTLED_WAIT_MS = [2_000, 5_000, 10_000];

export class Speaker {
  /** Which free allowances are gone (qwen-models.ts): a spent model is passed over for the next. */
  readonly spent: SpentBook;
  /** Told of every sentence made and every one served from disk (db.ts keeps the index). */
  ledger: TtsLedger | null = null;

  constructor(private key: () => string | undefined, private dir: string, private voiceOf: () => string | undefined = () => undefined) {
    mkdirSync(dir, { recursive: true });
    this.spent = new SpentBook(dir);
  }

  get ready() {
    return !!this.key();
  }

  get voice() {
    return this.voiceOf() || "Cherry";
  }

  /** v2: tightened audio. The version is in the name so old files are never served as new. */
  fileFor(text: string, version = 2, voice = this.voice): string {
    const hash = createHash("sha1").update(`${version === 2 ? "v2\n" : ""}${voice}\n${text}`).digest("hex").slice(0, 20);
    return join(this.dir, `${hash}.wav`);
  }

  cached(text: string, voice = this.voice): Buffer | null {
    const file = this.fileFor(text, 2, voice);
    if (existsSync(file)) return readFileSync(file);
    // A phrase kept before tightening: tightened now, no new call.
    const old = this.fileFor(text, 1, voice);
    if (!existsSync(old)) return null;
    const wav = tightenWav(readFileSync(old));
    writeFileSync(file, wav);
    return wav;
  }

  /** Renders under way, and those waiting their turn (RENDERS_AT_ONCE). */
  private rendering = 0;
  private turn: (() => void)[] = [];
  /** The waits after a refusal for the rate (a test shortens them). */
  throttledWaitMs = THROTTLED_WAIT_MS;

  /**
   * [text] on one model, as a WAV — a few at a time, and a refusal for the rate (429 Throttling.RateQuota) waited
   * out and tried again. A route's named sentences are asked all at once as it starts (warm, the page): 12 of them
   * came back 502 on a pretend drive (2026-10-03), and on the road the junction would have gone unnamed.
   * Throws SpentError where that model's allowance is gone.
   */
  private async render(key: string, tier: Tier, text: string, asked: string): Promise<Buffer> {
    // A slot taken here, or handed over by the render that finished (which then does not give it back): a waiter
    // woken and a newcomer could otherwise both see a free slot in the same moment.
    if (this.rendering >= RENDERS_AT_ONCE) await new Promise<void>((go) => this.turn.push(go));
    else this.rendering++;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.renderOnce(key, tier, text, asked);
        } catch (e) {
          if (attempt >= this.throttledWaitMs.length || !/429|RateQuota|rate limit/i.test((e as Error).message)) throw e;
          await new Promise((r) => setTimeout(r, this.throttledWaitMs[attempt]));
        }
      }
    } finally {
      const next = this.turn.shift();
      if (next) next(); // the slot passes to it
      else this.rendering--;
    }
  }

  private async renderOnce(key: string, tier: Tier, text: string, asked: string): Promise<Buffer> {
    const voice = tier === CLONED_TIER ? asked : voiceOn(tier, asked);
    if (tier.realtime) return wavOf(await realtime(key, tier.model, voice, text), 24_000);
    const answer = await fetch(`${BASE}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: tier.model, input: { text, voice, language_type: "Korean" } }),
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
    });
    if (!answer.ok) {
      const said = (await answer.text()).slice(0, 300);
      if (answer.status === 403 && saysSpent(said)) throw new SpentError(tier.model);
      throw new Error(`dashscope ${tier.model} ${answer.status}: ${said}`);
    }
    const body = (await answer.json()) as { output?: { audio?: { url?: string; data?: string } }; message?: string };
    if (body.output?.audio?.url) {
      const sound = await fetch(body.output.audio.url, { signal: AbortSignal.timeout(RENDER_TIMEOUT_MS) });
      if (!sound.ok) throw new Error(`audio url ${sound.status}`);
      return Buffer.from(await sound.arrayBuffer());
    }
    // Raw 24 kHz mono 16-bit samples, as the streaming form gives them.
    if (body.output?.audio?.data) return wavOf(Buffer.from(body.output.audio.data, "base64"), 24_000);
    throw new Error(`dashscope: no audio (${body.message ?? "?"})`);
  }

  /**
   * The WAV for [text] in [voice] (the server's own when none is asked),
   * from disk or from the service. A made voice is spoken by the cloning
   * model alone; when its allowance is gone the sentence comes in the
   * default voice instead, kept under that voice's name, not the made one's.
   */
  async say(text: string, voice = this.voice): Promise<Buffer> {
    const had = this.cached(text, voice);
    if (had) {
      this.ledger?.used(this.fileFor(text, 2, voice), voice, text, had.length);
      return had;
    }
    // One render a sentence at a time: the page, a warm-up and the prerender meeting the same new sentence
    // together would each pay for it.
    const inFlight = `${voice}|${text}`;
    let making = this.making.get(inFlight);
    if (!making) {
      making = this.make(text, voice).finally(() => this.making.delete(inFlight));
      this.making.set(inFlight, making);
    }
    return making;
  }

  private readonly making = new Map<string, Promise<Buffer>>();

  private async make(text: string, voice: string): Promise<Buffer> {
    const key = this.key();
    if (!key) throw new Error("tts has no key on this server");
    if (isMadeVoice(voice)) {
      if (!this.spent.isSpent(CLONED_MODEL)) {
        try {
          let wav = tightenWav(await this.render(key, CLONED_TIER, text, voice));
          let repaired = false;
          if (isClipped(wav)) {
            const again = tightenWav(await this.render(key, CLONED_TIER, `${text}.`, voice).catch(() => wav));
            if (tailRatio(again) < tailRatio(wav)) wav = again;
            repaired = true;
          }
          writeFileSync(this.fileFor(text, 2, voice), wav);
          this.ledger?.made(this.fileFor(text, 2, voice), voice, text, CLONED_MODEL, wav.length);
          if (repaired) this.ledger?.repaired?.(this.fileFor(text, 2, voice));
          return wav;
        } catch (e) {
          if (!(e instanceof SpentError)) throw e;
          this.spent.mark(CLONED_MODEL);
        }
      }
      return this.say(text, this.voice === voice ? "Cherry" : this.voice);
    }
    let wav: Buffer | null = null;
    let model: string | null = null;
    // Down the chain: a model whose free allowance is gone says so and the
    // next one speaks; any other refusal is the answer.
    for (const tier of CHAIN) {
      if (this.spent.isSpent(tier.model)) continue;
      try {
        wav = await this.render(key, tier, text, voice);
        model = tier.model;
        break;
      } catch (e) {
        if (!(e instanceof SpentError)) throw e;
        this.spent.mark(tier.model);
        console.warn(`tts: ${tier.model} free allowance spent; next model`);
      }
    }
    if (!wav) throw new Error(ALL_SPENT);
    wav = tightenWav(wav);
    // Cut off on its last syllable: asked once more with a full stop, which
    // the model ends a sentence on. Once is all: the ledger is told, so the
    // start-up repair (repairClipped) does not pay for a third take.
    let repaired = false;
    if (model && isClipped(wav)) {
      const tier = CHAIN.find((t) => t.model === model)!;
      try {
        const again = tightenWav(await this.render(key, tier, `${text}.`, voice));
        if (tailRatio(again) < tailRatio(wav)) wav = again;
      } catch { /* the first take stands */ }
      repaired = true;
    }
    // Kept under the voice it is in: a model with few voices speaks Sohee's sentence as Cherry, and filed as Sohee's
    // it stayed Cherry for good (92 such, 2026-10-02) — filed as Cherry's, Sohee's is asked again next time.
    const tier = CHAIN.find((t) => t.model === model);
    const spoken = tier ? voiceOn(tier, voice) : voice;
    writeFileSync(this.fileFor(text, 2, spoken), wav);
    this.ledger?.made(this.fileFor(text, 2, spoken), spoken, text, model, wav.length);
    if (repaired) this.ledger?.repaired?.(this.fileFor(text, 2, spoken));
    return wav;
  }
}

/** The loudest sample of a sentence, and the loudest in its last 30 ms. */
function peaks(wav: Buffer): { top: number; end: number } {
  const parsed = pcmOfWav(wav);
  if (!parsed) return { top: 1, end: 0 };
  const { pcm, rate } = parsed;
  const n = Math.floor(pcm.length / 2);
  const tail = Math.min(n, Math.round(rate * 0.03));
  let top = 1, end = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(pcm.readInt16LE(i * 2));
    if (v > top) top = v;
    if (i >= n - tail && v > end) end = v;
  }
  return { top, end };
}

/**
 * How loud a sentence still is in its last 30 ms, against its loudest: a
 * word that ends has faded to a few per cent; one cut off (the model
 * stopping on a number, "제한 속도 50") is still sounding.
 */
export function tailRatio(wav: Buffer): number {
  const { top, end } = peaks(wav);
  return end / top;
}
export const CLIPPED_RATIO = 0.05;
/** Still sounding at the end: louder than the ratio, and louder than what tighten() calls a pause — a quiet take's tail is silence, not a cut. */
export function isClipped(wav: Buffer): boolean {
  const { top, end } = peaks(wav);
  return end > QUIET && end / top > CLIPPED_RATIO;
}

/**
 * The kept sentences that end cut off: each taken out, and made again
 * (with its full stop) when its words are known and still wanted; one
 * whose words are not known is only taken out, to be made afresh the
 * next time it is asked for. One already made again once is left as it
 * is — the full stop was tried, and a third take would cost the same
 * and end the same. Runs after the server is up, so the files are read
 * one at a time with a turn of the loop between them.
 */
export async function repairClipped(
  speaker: Speaker,
  dir: string,
  known: (file: string) => { text: string; voice: string; repaired?: boolean } | null,
  wanted: (text: string) => boolean,
  forget: (file: string) => void,
): Promise<{ checked: number; clipped: number; remade: number; dropped: number; kept: number }> {
  const out = { checked: 0, clipped: 0, remade: 0, dropped: 0, kept: 0 };
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".wav"))) {
    await setImmediate();
    out.checked++;
    const path = join(dir, f);
    if (!isClipped(await readFile(path))) continue;
    out.clipped++;
    const row = known(f);
    if (row?.repaired) { out.kept++; continue; }
    await unlink(path);
    forget(f);
    if (row && wanted(row.text)) {
      try { await speaker.say(row.text, row.voice); out.remade++; } catch { out.dropped++; }
    } else out.dropped++;
  }
  return out;
}

export interface TtsLedger {
  made(file: string, voice: string, text: string, model: string | null, bytes: number): void;
  used(file: string, voice: string, text: string, bytes: number): void;
  /** The sentence was asked again with its full stop, and what came is kept: not to be tried a third time. */
  repaired?(file: string): void;
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

/** The samples and rate of a 16-bit mono WAV, reading to the end whatever the header claims (DashScope's says 2 GB). */
export function pcmOfWav(wav: Buffer): { pcm: Buffer; rate: number } | null {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return null;
  let at = 12, rate = 0, bits = 0, channels = 0;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "fmt ") {
      channels = wav.readUInt16LE(at + 10);
      rate = wav.readUInt32LE(at + 12);
      bits = wav.readUInt16LE(at + 22);
    } else if (id === "data") {
      if (bits !== 16 || channels !== 1) return null;
      const pcm = wav.subarray(at + 8);
      return { pcm: pcm.subarray(0, pcm.length - (pcm.length % 2)), rate };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/** Quieter than this (of 32767) in a 10 ms frame is a pause. */
const QUIET = 300;
/** Pauses inside a sentence are cut to this; a comma still sounds like one. */
export const MAX_PAUSE_MS = 180;
const LEAD_MS = 30;
const TAIL_MS = 120;

/**
 * Silence off both ends, and every pause inside cut to MAX_PAUSE_MS by
 * dropping its middle — what is dropped is near-silent, so no click.
 */
export function tighten(pcm: Buffer, rate: number): Buffer {
  const frame = Math.round(rate / 100);
  const frames = Math.floor(pcm.length / 2 / frame);
  const loud: boolean[] = [];
  for (let f = 0; f < frames; f++) {
    let peak = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i * 2)));
    loud.push(peak > QUIET);
  }
  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  if (first < 0) return pcm;
  const keep: [number, number][] = []; // frame ranges, end exclusive
  const maxPause = MAX_PAUSE_MS / 10;
  let from = Math.max(0, first - LEAD_MS / 10);
  let f = first;
  while (f <= last) {
    if (loud[f]) { f++; continue; }
    let g = f;
    while (g <= last && !loud[g]) g++;
    if (g - f > maxPause) {
      // Keep half the allowed pause on each side of the cut.
      keep.push([from, f + maxPause / 2]);
      from = g - maxPause / 2;
    }
    f = g;
  }
  keep.push([from, Math.min(frames, last + 1 + TAIL_MS / 10)]);
  return Buffer.concat(keep.map(([a, b]) => pcm.subarray(a * frame * 2, b * frame * 2)));
}

/** A kept WAV: tightened, with a header that tells its true length. Anything unreadable is left as it came. */
export function tightenWav(wav: Buffer): Buffer {
  const parsed = pcmOfWav(wav);
  return parsed ? wavOf(tighten(parsed.pcm, parsed.rate), parsed.rate) : wav;
}

/** Every fixed phrase into the cache; how many were made and how many were there. */
export async function prerender(speaker: Speaker, voice = speaker.voice): Promise<{ made: number; had: number }> {
  let made = 0, had = 0;
  for (const text of fixedPhrases()) {
    if (speaker.cached(text, voice)) { had++; continue; }
    // Model Studio rations requests by the minute (429 Throttling.RateQuota): a burst of new sentences waits and
    // tries again rather than giving the rest up; between sentences a short pause keeps under the rate.
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      try {
        await speaker.say(text, voice);
        done = true;
      } catch (e) {
        if (!/429|RateQuota|rate limit/i.test((e as Error).message)) throw e;
        // 10 s, 30 s, 60 s: a minute's ration refills; still throttled after that, this one is left for next time.
        if (attempt < 3) await new Promise((r) => setTimeout(r, [10_000, 30_000, 60_000][attempt]));
      }
    }
    if (!done) continue;
    made++;
    await new Promise((r) => setTimeout(r, 300));
  }
  return { made, had };
}
