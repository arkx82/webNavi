/**
 * TIDAL Embeds: TIDAL's own player in an iframe, the one place its terms
 * let a third party play whole songs — to a subscriber logged in inside it
 * (its Log in button, once). Everywhere else TIDAL allows 30 seconds.
 *
 * The embed takes `play` and `pause` from the page around it, but tells
 * nothing back (its media events are built but never sent), so the end of
 * a song is reckoned here from the song's length and the time it has been
 * playing since we asked it to — which is why the embed's own buttons are
 * best left alone and ours used instead.
 */
const ORIGIN = "https://embed.tidal.com";

export class TidalEmbed {
  private frame: HTMLIFrameElement | null = null;
  /** Seconds heard before the last play, and when that play began (null while paused). */
  private heard = 0;
  private since: number | null = null;
  private lengthS = 0;
  private tick: number | null = null;
  private asks: number[] = [];

  /** [ended] is called when the song's length has been heard. */
  constructor(private box: HTMLElement, private ended: () => void) {}

  get playing() { return this.since != null; }

  get positionS(): number {
    return this.heard + (this.since != null ? (performance.now() - this.since) / 1000 : 0);
  }

  /** A song into the embed, playing as soon as the embed can take the word. */
  load(trackId: string, lengthS: number | undefined) {
    this.stopAsking();
    this.heard = 0;
    this.since = null;
    this.lengthS = lengthS ?? 0;
    const frame = document.createElement("iframe");
    frame.src = `${ORIGIN}/tracks/${encodeURIComponent(trackId)}`;
    frame.allow = "autoplay; encrypted-media; fullscreen";
    frame.title = "TIDAL";
    frame.className = "tidal-embed";
    // The embed may not be ready when it has loaded; asking again is harmless (play is ignored while playing).
    frame.addEventListener("load", () => { this.asks = [600, 1800, 3500].map((ms) => window.setTimeout(() => this.say("play"), ms)); });
    this.frame?.remove();
    this.frame = frame;
    this.box.replaceChildren(frame);
    this.play();
  }

  play() {
    if (!this.frame) return;
    this.say("play");
    if (this.since == null) this.since = performance.now();
    this.tick ??= window.setInterval(() => this.check(), 1000);
  }

  pause() {
    this.stopAsking();
    this.say("pause");
    if (this.since != null) this.heard = this.positionS;
    this.since = null;
  }

  dispose() {
    this.pause();
    if (this.tick != null) clearInterval(this.tick);
    this.tick = null;
    this.frame?.remove();
    this.frame = null;
  }

  /** The song has been heard to its end (with a moment for the embed's own start). */
  private check() {
    if (this.since != null && this.lengthS > 0 && this.positionS >= this.lengthS + 2) {
      this.since = null;
      this.ended();
    }
  }

  private stopAsking() {
    for (const a of this.asks) clearTimeout(a);
    this.asks = [];
  }

  private say(commandName: "play" | "pause") {
    this.frame?.contentWindow?.postMessage(JSON.stringify({ commandName }), ORIGIN);
  }
}
