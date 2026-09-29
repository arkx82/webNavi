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
const SCOPES = ["user.read", "collection.read", "playlists.read", "playback", "recommendations.read"];
/** A playlist's tracks are fetched twenty a page; a queue this long is plenty for a drive. */
const QUEUE_PAGES = 10;

type Resource = { id: string; type: string; attributes: Record<string, unknown>; relationships?: Record<string, { data?: { id: string }[] }> };
type Page = { data: { id: string; type: string }[] | { id: string; type: string }; included?: Resource[]; links?: { next?: string } };
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
  /** The account's own country: the catalogue answers for it, not for where the car is. */
  private country = "KR";
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
    const me = (await this.api("/users/me")) as { data: { id: string; attributes?: { country?: string } } };
    this.userId = me.data.id;
    if (me.data.attributes?.country) this.country = me.data.attributes.country;
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

  /**
   * The account's own playlists, the ones it has saved (TIDAL's mixes and
   * editors' lists among them), and its recommended mixes where the login
   * allowed recommendations.read — each on its shelf. TIDAL's v2 API gives
   * these at /playlists?filter[owners.id]=me and /userCollectionPlaylists/me
   * (the older /userCollections/… answers 404 now).
   */
  async playlists(): Promise<Playlist[]> {
    const shelves: [string, string][] = [
      ["내 재생목록", "/playlists?filter[owners.id]=me&include=coverArt"],
      ["저장한 재생목록", "/userCollectionPlaylists/me/relationships/items?include=items,items.coverArt"],
      ["추천 믹스", `/userRecommendations/${this.userId}/relationships/myMixes?include=myMixes,myMixes.coverArt`],
    ];
    const out: Playlist[] = [];
    const seen = new Set<string>();
    for (const [group, path] of shelves) {
      let pages: Page[];
      try { pages = await this.pages(path, 3); } catch { continue; } // a shelf this login cannot see is left out
      const inc = new Map(pages.flatMap((p) => p.included ?? []).map((i) => [`${i.type}:${i.id}`, i]));
      for (const page of pages) {
        for (const d of Array.isArray(page.data) ? page.data : [page.data]) {
          const p = d.type === "playlists" ? (inc.get(`playlists:${d.id}`) ?? (d as Resource)) : null;
          if (!p || seen.has(d.id)) continue;
          seen.add(d.id);
          const a = p.attributes ?? {};
          out.push({ id: d.id, name: String(a.name ?? a.title ?? d.id), uri: d.id, count: typeof a.numberOfItems === "number" ? a.numberOfItems : undefined, art: artOf(inc, p, "coverArt", 160), group });
        }
      }
    }
    return out;
  }

  /** [path] and the pages after it, following TIDAL's cursor links, at most [max] pages. */
  private async pages(path: string, max: number): Promise<Page[]> {
    const out: Page[] = [];
    let next: string | undefined = path;
    while (next && out.length < max) {
      const page = (await this.api(next)) as Page;
      out.push(page);
      next = page.links?.next;
    }
    return out;
  }

  async play(playlistId: string): Promise<void> {
    const pages = await this.pages(`/playlists/${playlistId}/relationships/items?include=items,items.artists,items.albums,items.albums.coverArt`, QUEUE_PAGES);
    const inc = new Map(pages.flatMap((p) => p.included ?? []).map((i) => [`${i.type}:${i.id}`, i]));
    const coverOf = (albumId?: string): string | undefined => {
      const album = albumId ? inc.get(`albums:${albumId}`) : undefined;
      return album ? artOf(inc, album, "coverArt", 300) : undefined;
    };
    const items = pages.flatMap((p) => (Array.isArray(p.data) ? p.data : [p.data]));
    if (items.length === 0) throw new Error("이 재생목록에서 재생할 곡을 찾지 못했습니다");
    this.queue = items.filter((d) => d.type === "tracks").map((d) => {
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
    const url = new URL(path.startsWith("/v2/") ? `https://openapi.tidal.com${path}` : `${API}${path}`);
    url.searchParams.set("countryCode", this.country);
    const a = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.api+json" } });
    if (!a.ok) throw new Error(`TIDAL ${a.status} ${path.split("?")[0]}`);
    return a.json();
  }
}

/** A resource's artwork (its [rel] relationship) as the smallest file at least [px] wide. */
function artOf(inc: Map<string, Resource>, r: Resource, rel: string, px: number): string | undefined {
  const artId = r.relationships?.[rel]?.data?.[0]?.id;
  const files = (artId ? inc.get(`artworks:${artId}`)?.attributes.files : undefined) as { href: string; meta?: { width?: number } }[] | undefined;
  if (!files?.length) return undefined;
  const sorted = [...files].sort((a, b) => (a.meta?.width ?? 0) - (b.meta?.width ?? 0));
  return (sorted.find((f) => (f.meta?.width ?? 0) >= px) ?? sorted[sorted.length - 1]).href;
}
