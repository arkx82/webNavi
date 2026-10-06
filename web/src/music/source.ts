/**
 * One face for every place music comes from. The voice only needs
 * [setVolume] — that is the ducking — and the panel needs the rest.
 *
 * A stream from a URL runs through the page's audio graph and is ducked
 * with a GainNode; TIDAL plays under DRM inside its SDK, out of the
 * graph's reach, so it is ducked through its own volume.
 */
export interface Playlist {
  id: string;
  name: string;
  /** What [MusicSource.play] takes. */
  uri: string;
  count?: number;
  /** A cover, where the service has one. */
  art?: string;
  /** Which shelf it sits on: 내 재생목록, 저장한 재생목록, 추천, 곡. */
  group?: string;
  /** The small line under the name, instead of the song count: a song's artist. */
  sub?: string;
}

export interface NowPlaying {
  playing: boolean;
  title?: string;
  artist?: string;
  art?: string;
  /** Seconds into the track, and its length, when the source says. */
  positionS?: number;
  durationS?: number;
  /** A word from the service to show under the player (a preview, a failure), and whether it is a failure. */
  note?: string;
  noteBad?: boolean;
  /** The service's id for the track, and whether it is among the listener's likes (where the service says). */
  trackId?: string;
  liked?: boolean;
}

export interface MusicSource {
  readonly id: "stream" | "tidal";
  readonly label: string;
  /** Brings the SDK up and the account with it; throws with a reason to show. */
  connect(): Promise<void>;
  playlists(): Promise<Playlist[]>;
  /** Songs and lists across the whole service, where it has a search. */
  search?(q: string): Promise<Playlist[]>;
  play(uri: string): Promise<void>;
  toggle(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  /** Songs in a random order from here on (a playlist's rest), or back in the list's own order. */
  shuffle?(on: boolean): Promise<void>;
  /** The track playing put among the listener's likes, or taken out. */
  like?(on: boolean): Promise<void>;
  /** To [seconds] into the track, where the service allows it. */
  seek?(seconds: number): Promise<void>;
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
export async function tokenFor(service: "tidal"): Promise<string> {
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
  let loading: Promise<MusicSource> | null = null;
  const pending: ((now: NowPlaying) => void)[] = [];
  return {
    id, label,
    async connect() {
      // One load however many connect() overlap (this source, another, this again before the module came).
      real ??= await (loading ??= load().catch((e: unknown) => { loading = null; throw e; }));
      for (const l of pending) real.onState(l);
      pending.length = 0;
      await real.connect();
    },
    playlists: () => real!.playlists(),
    search: (q) => real?.search?.(q) ?? Promise.resolve([]),
    play: (uri) => real!.play(uri),
    toggle: () => real!.toggle(),
    next: () => real!.next(),
    previous: () => real!.previous(),
    seek: (s) => real?.seek?.(s) ?? Promise.resolve(),
    shuffle: (on) => real?.shuffle?.(on) ?? Promise.resolve(),
    like: (on) => real?.like?.(on) ?? Promise.resolve(),
    setVolume: (level) => real?.setVolume(level),
    onState(listener) { if (real) real.onState(listener); else pending.push(listener); },
    disconnect() { real?.disconnect(); },
  };
}
