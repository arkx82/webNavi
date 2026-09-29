import * as auth from "@tidal-music/auth";
import * as Player from "@tidal-music/player";
import type { MusicSource, NowPlaying, Playlist } from "./source";
import { isoSeconds } from "./tidal-time";

/**
 * TIDAL through its Player SDK — the only route TIDAL allows third
 * parties to play its bytes. The SDK expects to hold the account's
 * credentials itself; here it is handed a short-lived token from our
 * server and a fresh one before it expires, so the refresh token stays
 * on the server like Spotify's.
 *
 * The SDK plays one track at a time (`load` + `setNext`), so a playlist
 * is a queue kept here and fed on `ended`. Untested against a real
 * account at the time of writing; see the README.
 */
const CLIENT_UNIQUE_KEY = "tesla-nav";
const SCOPES = ["user.read", "collection.read", "playlists.read", "playback"];
const API = "https://openapi.tidal.com/v2";

interface Track {
  id: string;
  title: string;
  artist: string;
  art?: string;
  durationS?: number;
}


export class TidalSource implements MusicSource {
  readonly id = "tidal" as const;
  readonly label = "TIDAL";
  private listeners: ((now: NowPlaying) => void)[] = [];
  private queue: Track[] = [];
  private at = -1;
  private refresh: number | null = null;
  private clientId = "";
  private userId = "";
  private playing = false;

  async connect(): Promise<void> {
    const first = await this.fetchToken();
    this.clientId = first.clientId;
    await auth.init({ clientId: this.clientId, clientUniqueKey: CLIENT_UNIQUE_KEY, credentialsStorageKey: "tesla-nav-tidal", scopes: SCOPES });
    await this.giveToken(first.token, first.expiresIn);
    Player.setCredentialsProvider(auth.credentialsProvider);
    Player.events.addEventListener("ended", () => void this.advance());
    Player.events.addEventListener("playback-state-change", ((e: CustomEvent<{ state: string }>) => {
      this.playing = e.detail.state === "PLAYING";
      this.emitNow();
    }) as EventListener);
    const me = (await this.api("/users/me")) as { data: { id: string } };
    this.userId = me.data.id;
  }

  private async fetchToken() {
    const a = await fetch("/api/music/tidal/token");
    const j = (await a.json().catch(() => ({}))) as { token?: string; expiresIn?: number; clientId?: string; error?: string };
    if (!a.ok || !j.token || !j.clientId) throw new Error(j.error ?? `TIDAL ${a.status}`);
    return { token: j.token, expiresIn: j.expiresIn ?? 300, clientId: j.clientId };
  }

  /** Hands the SDK the token, and arranges the next one before this expires. */
  private async giveToken(token: string, expiresIn: number) {
    await auth.setCredentials({
      accessToken: {
        clientId: this.clientId,
        clientUniqueKey: CLIENT_UNIQUE_KEY,
        expires: Date.now() + expiresIn * 1000,
        grantedScopes: SCOPES,
        requestedScopes: SCOPES,
        token,
      },
    });
    if (this.refresh != null) clearTimeout(this.refresh);
    this.refresh = window.setTimeout(async () => {
      try {
        const next = await this.fetchToken();
        await this.giveToken(next.token, next.expiresIn);
      } catch { /* the next call will fail loudly */ }
    }, Math.max(30, expiresIn - 60) * 1000);
  }

  async playlists(): Promise<Playlist[]> {
    const j = (await this.api(`/userCollections/${this.userId}/relationships/playlists?include=playlists`)) as {
      included?: { id: string; type: string; attributes: { name: string; numberOfItems?: number } }[];
    };
    return (j.included ?? [])
      .filter((p) => p.type === "playlists")
      .map((p) => ({ id: p.id, name: p.attributes.name, uri: p.id, count: p.attributes.numberOfItems }));
  }

  async play(playlistId: string): Promise<void> {
    const j = (await this.api(`/playlists/${playlistId}/relationships/items?include=items,items.artists,items.albums,items.albums.coverArt`)) as {
      data: { id: string; type: string }[];
      included?: { id: string; type: string; attributes: Record<string, unknown>; relationships?: Record<string, { data: { id: string }[] }> }[];
    };
    const inc = new Map((j.included ?? []).map((i) => [`${i.type}:${i.id}`, i]));
    // A track's cover: its album's coverArt artwork, the smallest file of 300 px or more.
    const coverOf = (albumId?: string): string | undefined => {
      const artId = albumId ? inc.get(`albums:${albumId}`)?.relationships?.coverArt?.data?.[0]?.id : undefined;
      const files = (artId ? inc.get(`artworks:${artId}`)?.attributes.files : undefined) as { href: string; meta?: { width?: number } }[] | undefined;
      if (!files?.length) return undefined;
      const sorted = [...files].sort((a, b) => (a.meta?.width ?? 0) - (b.meta?.width ?? 0));
      return (sorted.find((f) => (f.meta?.width ?? 0) >= 300) ?? sorted[sorted.length - 1]).href;
    };
    this.queue = j.data.filter((d) => d.type === "tracks").map((d) => {
      const t = inc.get(`tracks:${d.id}`);
      const artistIds = t?.relationships?.artists?.data?.map((a) => a.id) ?? [];
      return {
        id: d.id,
        title: String(t?.attributes.title ?? d.id),
        artist: artistIds.map((id) => String(inc.get(`artists:${id}`)?.attributes.name ?? "")).filter(Boolean).join(", "),
        art: coverOf(t?.relationships?.albums?.data?.[0]?.id),
        durationS: isoSeconds(t?.attributes.duration),
      };
    });
    this.at = -1;
    await this.advance();
  }

  private async advance() {
    this.at++;
    const track = this.queue[this.at];
    if (!track) return;
    await Player.load({ productId: track.id, productType: "track", sourceId: "tesla-nav", sourceType: "PLAYLIST" }, 0);
    await Player.play();
    const next = this.queue[this.at + 1];
    if (next) Player.setNext({ productId: next.id, productType: "track", sourceId: "tesla-nav", sourceType: "PLAYLIST" });
    this.emitNow();
  }

  private emitNow() {
    const t = this.queue[this.at];
    let positionS: number | undefined;
    try { positionS = Player.getAssetPosition(); } catch { /* nothing loaded */ }
    for (const l of this.listeners) l({ playing: this.playing, title: t?.title, artist: t?.artist, art: t?.art, positionS, durationS: t?.durationS });
  }

  async seek(seconds: number) {
    await Player.seek(Math.max(0, seconds));
    this.emitNow();
  }

  async toggle() {
    if (this.playing) Player.pause(); else await Player.play();
  }
  async next() { await this.advance(); }
  async previous() {
    this.at = Math.max(-1, this.at - 2);
    await this.advance();
  }
  setVolume(level: number) { Player.setVolumeLevel(Math.max(0, Math.min(1, level))); }

  onState(listener: (now: NowPlaying) => void) { this.listeners.push(listener); }

  disconnect() {
    Player.pause();
    if (this.refresh != null) clearTimeout(this.refresh);
    this.refresh = null;
    this.queue = [];
    this.at = -1;
  }

  private async api(path: string): Promise<unknown> {
    const { token } = await auth.credentialsProvider.getCredentials();
    const url = new URL(`${API}${path}`);
    url.searchParams.set("countryCode", "KR");
    const a = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.api+json" } });
    if (!a.ok) throw new Error(`TIDAL ${a.status} ${path.split("?")[0]}`);
    return a.json();
  }
}
