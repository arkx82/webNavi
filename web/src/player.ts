import type { Voice } from "./voice";

/**
 * Music on the page, fed through the voice's graph so it can be ducked.
 * A stream from another origin only reaches the graph with CORS on it
 * (else the node plays silence), so streams go through the server's
 * /api/stream, which adds the header.
 */
export class Player {
  readonly audio: HTMLAudioElement;
  private wired = false;

  constructor(private voice: Voice) {
    this.audio = new Audio();
    this.audio.crossOrigin = "anonymous";
    this.audio.preload = "none";
  }

  async play(url: string) {
    await this.voice.unlock();
    if (!this.wired) {
      this.voice.context.createMediaElementSource(this.audio).connect(this.voice.music);
      this.wired = true;
    }
    this.audio.src = /^https?:/.test(url) ? `/api/stream?url=${encodeURIComponent(url)}` : url;
    await this.audio.play();
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }

  get playing() {
    return !this.audio.paused;
  }
}
