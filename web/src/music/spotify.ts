import { loadScript, tokenFor, type MusicSource, type NowPlaying, type Playlist } from "./source";

/**
 * Spotify through the Web Playback SDK: this page becomes a Spotify
 * Connect device ("Tesla Nav") and playback is moved onto it. Needs a
 * Premium account, and a browser with Widevine — whether the car's has
 * it is the first thing to find out.
 */
declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: {
      Player: new (options: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume?: number;
      }) => SpotifyPlayer;
    };
  }
}

interface SpotifyPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (payload: never) => void): void;
  togglePlay(): Promise<void>;
  nextTrack(): Promise<void>;
  previousTrack(): Promise<void>;
  setVolume(v: number): Promise<void>;
  activateElement(): Promise<void>;
}

interface SpotifyState {
  paused: boolean;
  track_window: { current_track: { name: string; artists: { name: string }[]; album: { images: { url: string }[] } } };
}

export class SpotifySource implements MusicSource {
  readonly id = "spotify" as const;
  readonly label = "Spotify";
  private player: SpotifyPlayer | null = null;
  private deviceId: string | null = null;
  private listeners: ((now: NowPlaying) => void)[] = [];

  async connect(): Promise<void> {
    await tokenFor("spotify"); // fails early with the server's reason
    const ready = new Promise<void>((done) => {
      if (window.Spotify) return done();
      window.onSpotifyWebPlaybackSDKReady = () => done();
    });
    await loadScript("https://sdk.scdn.co/spotify-player.js");
    await ready;
    const player = new window.Spotify!.Player({
      name: "Tesla Nav",
      getOAuthToken: (cb) => void tokenFor("spotify").then(cb),
      volume: 1,
    });
    const online = new Promise<string>((done, fail) => {
      player.addListener("ready", ((p: { device_id: string }) => done(p.device_id)) as never);
      for (const e of ["initialization_error", "authentication_error", "account_error", "playback_error"]) {
        player.addListener(e, ((p: { message: string }) => fail(new Error(`${e}: ${p.message}`))) as never);
      }
    });
    player.addListener("player_state_changed", ((s: SpotifyState | null) => {
      if (!s) return;
      const t = s.track_window.current_track;
      this.emit({ playing: !s.paused, title: t.name, artist: t.artists.map((a) => a.name).join(", "), art: t.album.images[0]?.url });
    }) as never);
    if (!(await player.connect())) throw new Error("Spotify SDK did not connect");
    this.player = player;
    this.deviceId = await online;
    // Make this page the playing device, without starting anything yet.
    await this.api("PUT", "/me/player", { device_ids: [this.deviceId], play: false }).catch(() => undefined);
  }

  async playlists(): Promise<Playlist[]> {
    const j = (await this.api("GET", "/me/playlists?limit=50")) as { items: { id: string; name: string; uri: string; tracks: { total: number } }[] };
    return j.items.map((p) => ({ id: p.id, name: p.name, uri: p.uri, count: p.tracks.total }));
  }

  async play(uri: string): Promise<void> {
    await this.player?.activateElement().catch(() => undefined);
    await this.api("PUT", `/me/player/play?device_id=${this.deviceId}`, { context_uri: uri });
  }

  async toggle() { await this.player?.togglePlay(); }
  async next() { await this.player?.nextTrack(); }
  async previous() { await this.player?.previousTrack(); }
  setVolume(level: number) { void this.player?.setVolume(Math.max(0, Math.min(1, level))); }

  onState(listener: (now: NowPlaying) => void) { this.listeners.push(listener); }
  private emit(now: NowPlaying) { for (const l of this.listeners) l(now); }

  disconnect() {
    this.player?.disconnect();
    this.player = null;
    this.deviceId = null;
  }

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await tokenFor("spotify");
    const a = await fetch(`https://api.spotify.com/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!a.ok && a.status !== 204) {
      const j = (await a.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(j.error?.message ?? `Spotify ${a.status}`);
    }
    return a.status === 204 ? null : a.json();
  }
}
