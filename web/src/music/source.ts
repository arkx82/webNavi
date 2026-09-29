/**
 * One face for every place music comes from. The voice only needs
 * [setVolume] — that is the ducking — and the panel needs the rest.
 *
 * A stream from a URL runs through the page's audio graph and is ducked
 * with a GainNode; Spotify and TIDAL play under DRM inside their SDKs,
 * out of the graph's reach, so they are ducked through their own volume.
 */
export interface Playlist {
  id: string;
  name: string;
  /** What [MusicSource.play] takes. */
  uri: string;
  count?: number;
}

export interface NowPlaying {
  playing: boolean;
  title?: string;
  artist?: string;
  art?: string;
}

export interface MusicSource {
  readonly id: "stream" | "spotify" | "tidal";
  readonly label: string;
  /** Brings the SDK up and the account with it; throws with a reason to show. */
  connect(): Promise<void>;
  playlists(): Promise<Playlist[]>;
  play(uri: string): Promise<void>;
  toggle(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  /** 0..1; called by the voice around every phrase. */
  setVolume(level: number): void;
  onState(listener: (now: NowPlaying) => void): void;
  disconnect(): void;
}

/** A script tag once, resolved when it has run. */
export function loadScript(src: string): Promise<void> {
  return new Promise((done, fail) => {
    if (document.querySelector(`script[src="${src}"]`)) return done();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => done();
    s.onerror = () => fail(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

/** A live access token from the server, which holds the refresh token. */
export async function tokenFor(service: "spotify" | "tidal"): Promise<string> {
  const a = await fetch(`/api/music/${service}/token`);
  const j = (await a.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!a.ok || !j.token) throw new Error(j.error ?? `${service}: ${a.status}`);
  return j.token;
}

/**
 * A source whose module is fetched only when it is chosen: the DRM SDKs
 * are large and most drives never touch them.
 */
export function lazy(id: MusicSource["id"], label: string, load: () => Promise<MusicSource>): MusicSource {
  let real: MusicSource | null = null;
  const pending: ((now: NowPlaying) => void)[] = [];
  return {
    id, label,
    async connect() {
      real ??= await load();
      for (const l of pending) real.onState(l);
      pending.length = 0;
      await real.connect();
    },
    playlists: () => real!.playlists(),
    play: (uri) => real!.play(uri),
    toggle: () => real!.toggle(),
    next: () => real!.next(),
    previous: () => real!.previous(),
    setVolume: (level) => real?.setVolume(level),
    onState(listener) { if (real) real.onState(listener); else pending.push(listener); },
    disconnect() { real?.disconnect(); },
  };
}
