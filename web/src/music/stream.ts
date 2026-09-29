import type { Voice } from "../voice";
import type { MusicSource, NowPlaying, Playlist } from "./source";

/**
 * A plain stream — internet radio, a self-hosted MP3 — through the page's
 * audio graph, so the voice ducks it with the GainNode. Another origin's
 * stream only reaches the graph with CORS on it, so http(s) URLs go
 * through the server's /api/stream, which adds the header.
 */
export class StreamSource implements MusicSource {
  readonly id = "stream" as const;
  readonly label = "스트림 URL";
  readonly audio: HTMLAudioElement;
  private wired = false;
  private listeners: ((now: NowPlaying) => void)[] = [];
  /** The URLs the driver has played, newest first, kept in the browser. */
  private recent: string[] = [];

  constructor(private voice: Voice) {
    this.audio = new Audio();
    this.audio.crossOrigin = "anonymous";
    this.audio.preload = "none";
    for (const e of ["play", "pause", "ended"]) {
      this.audio.addEventListener(e, () => this.emit({ playing: !this.audio.paused, title: this.audio.src ? new URL(this.audio.src).searchParams.get("url") ?? this.audio.src : undefined }));
    }
    try { this.recent = JSON.parse(localStorage.getItem("nav-streams") ?? "[]"); } catch { /* none */ }
  }

  async connect() { /* nothing to log into */ }

  async playlists(): Promise<Playlist[]> {
    return this.recent.map((u) => ({ id: u, name: u.replace(/^https?:\/\//, ""), uri: u }));
  }

  async play(url: string) {
    await this.voice.unlock();
    if (!this.wired) {
      this.voice.context.createMediaElementSource(this.audio).connect(this.voice.music);
      this.wired = true;
    }
    this.audio.src = /^https?:/.test(url) ? `/api/stream?url=${encodeURIComponent(url)}` : url;
    await this.audio.play();
    this.recent = [url, ...this.recent.filter((u) => u !== url)].slice(0, 8);
    try { localStorage.setItem("nav-streams", JSON.stringify(this.recent)); } catch { /* private window */ }
  }

  async toggle() {
    if (this.audio.paused) await this.audio.play(); else this.audio.pause();
  }
  async next() { /* a stream has no next */ }
  async previous() { /* nor a previous */ }
  /** Ducked by the graph's GainNode, not here. */
  setVolume() { /* handled by Voice.music */ }

  onState(listener: (now: NowPlaying) => void) { this.listeners.push(listener); }
  private emit(now: NowPlaying) { for (const l of this.listeners) l(now); }

  disconnect() {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}
