import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Qwen models a sentence may be spoken with, and which have used up
 * their free allowance — the way PaperFlow does it (QwenModels.kt).
 *
 * Six IDs are one model, Qwen3-TTS-Flash: its alias and its dated
 * snapshots, answered or streamed over a socket. Model Studio gives each
 * ID an allowance of its own, and with the account's "free quota only"
 * switch on, a spent one answers 403 AllocationQuota.FreeTierOnly instead
 * of charging. So a sentence refused that way is asked of the next ID,
 * and the spent one is not asked again for a day (asking costs nothing —
 * it refuses before it speaks — but it is a wasted round trip).
 *
 * Only IDs with an allowance of their own are in the chain: one without
 * would go on at the owner's expense.
 */
export interface Tier {
  model: string;
  realtime: boolean;
  /** Has every voice; the 2025-09-18 snapshot has only a few. */
  full: boolean;
}

export const CHAIN: Tier[] = [
  { model: "qwen3-tts-flash", realtime: false, full: true },
  { model: "qwen3-tts-flash-2025-11-27", realtime: false, full: true },
  { model: "qwen3-tts-flash-realtime", realtime: true, full: true },
  { model: "qwen3-tts-flash-realtime-2025-11-27", realtime: true, full: true },
  { model: "qwen3-tts-flash-2025-09-18", realtime: false, full: false },
  { model: "qwen3-tts-flash-realtime-2025-09-18", realtime: true, full: false },
];

/** The voices the 2025-09-18 snapshots have. */
const OLD_VOICES = new Set(["Cherry", "Ethan", "Jennifer", "Ryan", "Katerina", "Elias"]);
const MALE = new Set(["Ethan", "Ryan", "Elias", "Dylan", "Marcus", "Roy", "Peter", "Rocky", "Eric", "Kiki"]);

/** [voice] on [tier]: itself where the model has it, else the plainest voice of the same sex that it does. */
export function voiceOn(tier: Tier, voice: string): string {
  if (tier.full || OLD_VOICES.has(voice)) return voice;
  return MALE.has(voice) ? "Ethan" : "Cherry";
}

/** Whether a refusal's text is Model Studio saying the free allowance is gone. */
export function saysSpent(text: string): boolean {
  return /FreeTierOnly/.test(text) || /free tier/i.test(text);
}

export class SpentError extends Error {
  constructor(public model: string) {
    super(`${model}: free allowance used up`);
  }
}

export const ALL_SPENT = "qwen: every free allowance is spent";
const RETRY_MS = 24 * 3600_000;

/** Model → when it said its allowance was gone; kept beside the audio so a restart remembers. */
export class SpentBook {
  private spent: Record<string, number> = {};
  private file: string;

  constructor(dir: string) {
    this.file = join(dir, "spent.json");
    try { if (existsSync(this.file)) this.spent = JSON.parse(readFileSync(this.file, "utf8")); } catch { /* start clean */ }
  }

  isSpent(model: string, now = Date.now()): boolean {
    const at = this.spent[model];
    return at != null && now - at < RETRY_MS;
  }

  mark(model: string) {
    this.spent[model] = Date.now();
    try { writeFileSync(this.file, JSON.stringify(this.spent)); } catch { /* memory still knows */ }
  }

  /** The first model that is not spent, for the settings page to say what speaks now. */
  current(): string | null {
    return CHAIN.find((t) => !this.isSpent(t.model))?.model ?? null;
  }

  spentModels(): string[] {
    return CHAIN.filter((t) => this.isSpent(t.model)).map((t) => t.model);
  }
}

const REALTIME_URL = "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime";

/**
 * [text] spoken by [voice] on a realtime [model]: a session opened, the text
 * sent and committed, and the audio gathered as it comes (24 kHz 16-bit
 * mono, like the others). Throws SpentError where the allowance is gone.
 */
/**
 * What a realtime message refuses with, or null: the "error" event, and
 * the bare {code, message} Model Studio sends with no type at all — which
 * is how the spent free allowance comes (AllocationQuota.FreeTierOnly),
 * before the socket is simply dropped (closed 1006, no reason).
 */
export function realtimeFault(model: string, event: { type?: string; code?: string; message?: string; error?: { code?: string; message?: string } }): Error | null {
  const said = event.type === "error" ? event.error : event.type === undefined && event.code ? event : null;
  if (!said) return null;
  const text = [said.code, said.message].filter(Boolean).join(": ");
  return saysSpent(text) ? new SpentError(model) : new Error(`${model}: ${text}`);
}

export function realtime(key: string, model: string, voice: string, text: string, timeoutMs = 30_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already */ }
      if (error) reject(error);
      else if (chunks.length === 0) reject(new Error(`${model}: no audio in the answer`));
      else resolve(Buffer.concat(chunks));
    };
    // Node's WebSocket (undici) takes headers in its second argument.
    const socket = new WebSocket(`${REALTIME_URL}?model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${key}` } } as unknown as string[]);
    const timer = setTimeout(() => finish(new Error(`${model}: no answer in time`)), timeoutMs);
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "session.update", session: { mode: "commit", voice, language_type: "Korean", response_format: "pcm", sample_rate: 24_000 } }));
      socket.send(JSON.stringify({ type: "input_text_buffer.append", text }));
      socket.send(JSON.stringify({ type: "input_text_buffer.commit" }));
    };
    socket.onmessage = (message) => {
      let event: { type?: string; delta?: string; error?: { code?: string; message?: string } };
      try { event = JSON.parse(String(message.data)); } catch { return; }
      if (event.type === "response.audio.delta" && event.delta) chunks.push(Buffer.from(event.delta, "base64"));
      else if (event.type === "response.done") socket.send(JSON.stringify({ type: "session.finish" }));
      else if (event.type === "session.finished") finish(null);
      else {
        const fault = realtimeFault(model, event);
        if (fault) finish(fault);
      }
    };
    socket.onerror = () => finish(new Error(`${model}: socket failed`));
    socket.onclose = (e) => {
      if (saysSpent(e.reason ?? "")) finish(new SpentError(model));
      else if (chunks.length) finish(null);
      else finish(new Error(`${model}: closed ${e.code} ${e.reason ?? ""}`));
    };
  });
}
