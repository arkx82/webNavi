/**
 * The voice and the music, on one Web Audio graph, so the voice can turn
 * the music down while it speaks. Phrases are queued: two warnings a
 * second apart play one after the other, never on top of each other.
 *
 * The car's own audio is out of reach — the browser cannot duck Spotify —
 * which is why the music lives in this page too; see [Player].
 */
/** The same sentence is not said twice within this. */
const REPEAT_MS = 20_000;

export class Voice {
  readonly context: AudioContext;
  /** The music's volume knob; the voice turns it down. */
  readonly music: GainNode;
  private readonly speech: GainNode;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private queue: string[] = [];
  private speaking = false;
  /** When each sentence was last said: the same one again this soon is dropped. */
  private lastSaid = new Map<string, number>();
  /** Off, the voice says nothing (the chime too). */
  enabled = true;
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

  /** Browsers start audio suspended until a tap; call this from one. */
  async unlock() {
    if (this.context.state !== "running") await this.context.resume();
  }

  /**
   * Queues [text]. The same sentence already waiting, or said within
   * REPEAT_MS, is dropped: a re-route re-reads the same turn, a guide and
   * a warning can land on one spot, and a driver needs to hear it once.
   */
  say(text: string) {
    if (!this.enabled) return;
    const last = this.lastSaid.get(text);
    if (this.queue.includes(text) || (last != null && Date.now() - last < REPEAT_MS)) return;
    this.lastSaid.set(text, Date.now());
    this.queue.push(text);
    void this.buffer(text); // fetch early, play in turn
    if (!this.speaking) void this.next();
  }

  private buffer(text: string): Promise<AudioBuffer> {
    let had = this.buffers.get(text);
    if (!had) {
      // v=2: tightened audio; the browser keeps the old answer for a year under the old address.
      had = fetch(`/api/tts?text=${encodeURIComponent(text)}&v=2`)
        .then(async (a) => {
          if (!a.ok) throw new Error((await a.json().catch(() => ({}))).error ?? `${a.status}`);
          return this.context.decodeAudioData(await a.arrayBuffer());
        })
        .catch((e) => {
          this.buffers.delete(text);
          throw e;
        });
      this.buffers.set(text, had);
    }
    return had;
  }

  private async next() {
    const text = this.queue.shift();
    if (text == null) {
      this.speaking = false;
      this.duck(false);
      return;
    }
    this.speaking = true;
    try {
      const buffer = await this.buffer(text);
      await this.unlock();
      this.duck(true);
      await new Promise<void>((done) => {
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.speech);
        source.onended = () => done();
        source.start();
      });
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
