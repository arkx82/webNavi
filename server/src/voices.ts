import { Cache } from "./nearby/util.js";

/**
 * The voices the guidance can speak in: Qwen3-TTS's own, and the ones the
 * owner made from a recording in their Model Studio account — the list
 * PaperFlow reads from (CloudSpeechEngine.QWEN_VOICES, ClonedVoices.kt).
 *
 * A made voice is an id bound to the cloning model (CLONED_MODEL) and is
 * spoken only by it; the account keeps just the Latin part of the name it
 * was made under, which is the name it comes back with.
 */
export interface SystemVoice {
  name: string;
  female: boolean;
  /** A word for the list: Sohee is the one Korean voice; the rest speak Korean with an accent of their own. */
  note?: string;
}

export const SYSTEM_VOICES: SystemVoice[] = [
  { name: "Sohee", female: true, note: "한국어 목소리" },
  { name: "Cherry", female: true, note: "기본" },
  { name: "Serena", female: true },
  { name: "Maia", female: true },
  { name: "Katerina", female: true },
  { name: "Mia", female: true },
  { name: "Seren", female: true },
  { name: "Vivian", female: true },
  { name: "Bella", female: true },
  { name: "Bellona", female: true },
  { name: "Stella", female: true },
  { name: "Jennifer", female: true },
  { name: "Elias", female: true },
  { name: "Ethan", female: false },
  { name: "Andre", female: false },
  { name: "Neil", female: false },
  { name: "Kai", female: false },
  { name: "Arthur", female: false },
  { name: "Vincent", female: false },
  { name: "Eldric Sage", female: false },
  { name: "Ryan", female: false },
  { name: "Moon", female: false },
  { name: "Mochi", female: false },
  { name: "Aiden", female: false },
];

export const CLONED_MODEL = "qwen3-tts-vc-2026-01-22";
const ENDPOINT = "https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization";

export interface MadeVoice {
  id: string;
  name: string;
}

/** "qwen-tts-vc-pf_jun-voice-2026…" → "jun"; null where it was made without a name. */
export function nameIn(id: string): string | null {
  const made = id.replace(/^qwen-tts-vc-/, "").split("-voice-")[0];
  if (made === id || !made || made === "pf_voice") return null;
  return made.replace(/^pf_/, "") || null;
}

export class MadeVoices {
  private cache = new Cache<MadeVoice[]>(10 * 60_000, 4);

  constructor(private key: () => string | undefined) {}

  /** The owner's own voices for the cloning model, newest list at most ten minutes old. */
  list(): Promise<MadeVoice[]> {
    const key = this.key();
    if (!key) return Promise.resolve([]);
    return this.cache.get(key.slice(-8), async () => {
      const found: { voice?: string; target_model?: string }[] = [];
      for (let page = 0; page < 10; page++) {
        const answer = await fetch(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "qwen-voice-enrollment", input: { action: "list", page_size: 100, page_index: page } }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = (await answer.json().catch(() => ({}))) as { output?: { voice_list?: typeof found; total_count?: number }; message?: string };
        if (!answer.ok) throw new Error(`voices: ${answer.status} ${body.message ?? ""}`);
        const list = body.output?.voice_list ?? [];
        found.push(...list);
        if (list.length < 100 || found.length >= (body.output?.total_count ?? found.length)) break;
      }
      const seen = new Set<string>();
      let n = 0;
      return found
        .filter((v) => v.target_model === CLONED_MODEL && v.voice && !seen.has(v.voice) && !!seen.add(v.voice))
        .map((v) => ({ id: v.voice!, name: nameIn(v.voice!) ?? `내 목소리 ${++n}` }));
    });
  }

  /** Whether [voice] is one of the owner's own. */
  async isMade(voice: string): Promise<boolean> {
    if (!/^qwen-tts-vc-/.test(voice)) return false;
    return (await this.list().catch(() => [])).some((v) => v.id === voice);
  }
}
