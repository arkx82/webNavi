import { koreanNumbers } from "../../server/src/phrases";
/**
 * The voice and the music, on one Web Audio graph, so the voice can turn
 * the music down while it speaks. Phrases are queued: two warnings a
 * second apart play one after the other, never on top of each other.
 *
 * The car's own audio is out of reach — the browser cannot duck the car's apps —
 * which is why the music lives in this page too; see [Player].
 */
/** The same sentence is not said twice within this. */
const REPEAT_MS = 20_000;
/**
 * Silence before and after each sentence. The model ends its audio on the
 * last syllable, and a phone's Bluetooth or car link closes as soon as the
 * sound stops — swallowing that syllable — and takes a moment to open.
 */
const LEAD_S = 0.15;
/** How long a queued sentence stays true: a turn's "잠시 후" a few seconds, a warning a little longer. */
const TURN_WITHIN_S = 10;
const WITHIN_S = 15;
const TAIL_S = 0.35;
const FADE_S = 0.03;
/**
 * Sentences kept decoded. A junction's named sentence is its own, a decoded
 * buffer is hundreds of KB, and the page is open for hours: the least
 * recently used go once there are this many.
 */
const KEPT_BUFFERS = 80;

export class Voice {
  readonly context: AudioContext;
  /** The music's volume knob; the voice turns it down. */
  readonly music: GainNode;
  private readonly speech: GainNode;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  /**
   * Each with the sentence to say instead if its own cannot be had (a name
   * the service would not render), when it was asked for, and by when it
   * must be said to still be true ("잠시 후 좌회전" after the corner is wrong).
   */
  private queue: { text: string; fallback?: string; key: string; at: number; until: number; turn: boolean }[] = [];
  private speaking = false;
  /** The sentence playing, held so no browser collects it half-way. */
  private playing: AudioBufferSourceNode | null = null;
  /** Told how each sentence went: how long it waited in the queue, how much of it played, its length (the 진단 log). */
  onSaid: (text: string, playedS: number, lengthS: number, waitedS: number) => void = () => {};
  /** Told of a sentence dropped because its moment had passed while others were being said. */
  onLate: (text: string, waitedS: number) => void = () => {};
  /** When each sentence was last said, by its key: the same one again this soon is dropped. */
  private lastSaid = new Map<string, number>();
  /** Off, the voice says nothing (the chime too). */
  enabled = true;
  /** The voice asked of the server (안내 설정 → 목소리); null is the server's own. */
  voiceName: string | null = null;
  /** How far the music drops while the voice speaks. */
  duckTo = 0.3;
  /** Players outside the graph (DRM SDKs) that take the same level. */
  readonly duckers = new Set<(level: number) => void>();
  onError: (message: string) => void = () => {};

  constructor() {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.context = new Ctor();
    this.music = this.context.createGain();
    this.speech = this.context.createGain();
    this.music.connect(this.context.destination);
    this.speech.connect(this.context.destination);
  }

  /**
   * Browsers start audio suspended until a tap; call this from one. Once
   * running, a silent source is kept playing: the car's browser puts a
   * context to sleep after a while of nothing, and a sleeping one waits
   * for the next tap before it speaks — which looked like the guidance
   * only working after 모의 주행 was pressed.
   */
  async unlock() {
    if (this.context.state !== "running") await this.context.resume();
    if (!this.keepAwake && this.context.state === "running") {
      const hush = this.context.createGain();
      hush.gain.value = 0;
      hush.connect(this.context.destination);
      const tone = this.context.createConstantSource();
      tone.connect(hush);
      tone.start();
      this.keepAwake = tone;
    }
  }
  private keepAwake: ConstantSourceNode | null = null;

  /** Whether sound can be heard now, or needs a tap first. */
  get awake(): boolean {
    return this.context.state === "running";
  }

  /**
   * Queues [text]. The same sentence already waiting, or said within
   * REPEAT_MS, is dropped: a re-route re-reads the same turn, a guide and
   * a warning can land on one spot, and a driver needs to hear it once.
   */
  say(text: string, fallback?: string, opts: { key?: string; turn?: boolean; withinS?: number } = {}) {
    if (!this.enabled) return;
    // No digit reaches the voice: "왕산로40길" is 왕산로사십길, "300m" 삼백미터 (the fixed phrases come so already).
    text = koreanNumbers(text);
    if (fallback) fallback = koreanNumbers(fallback);
    // The same thing said twice is dropped; two junctions (or two cameras) that read alike are not the same thing.
    const key = opts.key ?? text;
    const now = Date.now();
    // Only the last REPEAT_MS matter; older marks are dropped so the map does not grow with every junction passed.
    for (const [k, t] of this.lastSaid) if (now - t >= REPEAT_MS) this.lastSaid.delete(k);
    const last = this.lastSaid.get(key);
    if (this.queue.some((q) => q.key === key) || (last != null && now - last < REPEAT_MS)) return;
    this.lastSaid.set(key, now);
    const item = { text, fallback, key, at: now, until: now + (opts.withinS ?? (opts.turn ? TURN_WITHIN_S : WITHIN_S)) * 1000, turn: !!opts.turn };
    // A turn goes before the warnings waiting: it is the one that cannot wait.
    const firstWarning = opts.turn ? this.queue.findIndex((q) => !q.turn) : -1;
    if (firstWarning >= 0) this.queue.splice(firstWarning, 0, item);
    else this.queue.push(item);
    void this.buffer(text).catch(() => {}); // fetch early, play in turn
    if (!this.speaking) void this.next();
  }

  /** Asks for [text]'s sound now, to be ready when it is said (a sentence the server may still have to make). */
  prefetch(text: string) {
    void this.buffer(text).catch(() => {});
  }

  /** [text] now, even if it was just said: for hearing a voice before choosing it. */
  preview(text: string) {
    this.lastSaid.delete(text);
    this.say(text);
  }

  private buffer(text: string): Promise<AudioBuffer> {
    const key = `${this.voiceName ?? ""}|${text}`;
    let had = this.buffers.get(key);
    // Used again: newest in the order the least recently used are dropped by.
    if (had) { this.buffers.delete(key); this.buffers.set(key, had); }
    else {
      // v=3: sentences cut off at the end made again (tts.ts); the browser keeps each answer a year under its address.
      const voice = this.voiceName ? `&voice=${encodeURIComponent(this.voiceName)}` : "";
      had = fetch(`/api/tts?text=${encodeURIComponent(text)}&v=3${voice}`)
        .then(async (a) => {
          if (!a.ok) throw new Error((await a.json().catch(() => ({}))).error ?? `${a.status}`);
          return padded(this.context, await this.context.decodeAudioData(await a.arrayBuffer()));
        })
        .catch((e) => {
          this.buffers.delete(key);
          throw e;
        });
      this.buffers.set(key, had);
      for (const k of this.buffers.keys()) {
        if (this.buffers.size <= KEPT_BUFFERS) break;
        this.buffers.delete(k);
      }
    }
    return had;
  }

  private async next() {
    const item = this.queue.shift();
    if (item == null) {
      this.speaking = false;
      this.duck(false);
      return;
    }
    let text = item.text;
    // Its moment passed while others were said: better unsaid than said at the wrong place.
    if (Date.now() > item.until) {
      this.onLate(text, (Date.now() - item.at) / 1000);
      void this.next();
      return;
    }
    this.speaking = true;
    try {
      let buffer: AudioBuffer;
      try {
        buffer = await this.buffer(text);
      } catch (e) {
        if (!item.fallback) throw e;
        this.onError(`${text}: ${(e as Error).message} — 대신 "${item.fallback}"`);
        text = item.fallback;
        buffer = await this.buffer(text);
      }
      await this.unlock();
      this.duck(true);
      const began = this.context.currentTime;
      await new Promise<void>((done) => {
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.speech);
        source.onended = () => done();
        this.playing = source;
        source.start();
      });
      this.playing = null;
      this.onSaid(text, this.context.currentTime - began, buffer.duration, (Date.now() - item.at) / 1000 - buffer.duration);
    } catch (e) {
      this.onError(`${text}: ${(e as Error).message}`);
    }
    void this.next();
  }

  /** 0..1 for the voice (and the chime); the music keeps its own level. */
  setVolume(level: number) {
    this.speech.gain.setTargetAtTime(Math.max(0, Math.min(1, level)), this.context.currentTime, 0.05);
  }

  /**
   * A soft two-note chime, for over the limit: sine tones that swell in
   * and fade out rather than beep, quieter than the voice, and never over
   * a sentence being said.
   */
  chime() {
    if (!this.enabled || this.speaking || this.context.state !== "running") return;
    const t = this.context.currentTime;
    const out = this.context.createGain();
    out.gain.value = 0.22;
    out.connect(this.speech);
    for (const [freq, at] of [[880, 0], [660, 0.18]] as const) {
      const osc = this.context.createOscillator();
      const env = this.context.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0, t + at);
      env.gain.linearRampToValueAtTime(1, t + at + 0.03);
      env.gain.exponentialRampToValueAtTime(0.001, t + at + 0.45);
      osc.connect(env).connect(out);
      osc.start(t + at);
      osc.stop(t + at + 0.5);
    }
  }

  private duck(down: boolean) {
    const now = this.context.currentTime;
    this.music.gain.cancelScheduledValues(now);
    this.music.gain.setTargetAtTime(down ? this.duckTo : 1, now, down ? 0.08 : 0.4);
    for (const d of this.duckers) d(down ? this.duckTo : 1);
  }
}

/** [buffer] with LEAD_S of silence before, TAIL_S after, and its last FADE_S faded out (a cut-off syllable does not click). */
function padded(context: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  const rate = buffer.sampleRate;
  const lead = Math.round(LEAD_S * rate), tail = Math.round(TAIL_S * rate), fade = Math.min(buffer.length, Math.round(FADE_S * rate));
  const out = context.createBuffer(buffer.numberOfChannels, buffer.length + lead + tail, rate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c).slice();
    for (let i = 0; i < fade; i++) data[data.length - 1 - i] *= i / fade;
    out.copyToChannel(data, c, lead);
  }
  return out;
}
