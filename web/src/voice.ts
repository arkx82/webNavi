/**
 * The voice and the music, on one Web Audio graph, so the voice can turn
 * the music down while it speaks. Phrases are queued: two warnings a
 * second apart play one after the other, never on top of each other.
 *
 * The car's own audio is out of reach — the browser cannot duck Spotify —
 * which is why the music lives in this page too; see [Player].
 */
export class Voice {
  readonly context: AudioContext;
  /** The music's volume knob; the voice turns it down. */
  readonly music: GainNode;
  private readonly speech: GainNode;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private queue: string[] = [];
  private speaking = false;
  /** How far the music drops while the voice speaks. */
  duckTo = 0.3;
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

  say(text: string) {
    this.queue.push(text);
    void this.buffer(text); // fetch early, play in turn
    if (!this.speaking) void this.next();
  }

  private buffer(text: string): Promise<AudioBuffer> {
    let had = this.buffers.get(text);
    if (!had) {
      had = fetch(`/api/tts?text=${encodeURIComponent(text)}`)
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

  private duck(down: boolean) {
    const now = this.context.currentTime;
    this.music.gain.cancelScheduledValues(now);
    this.music.gain.setTargetAtTime(down ? this.duckTo : 1, now, down ? 0.08 : 0.4);
  }
}
