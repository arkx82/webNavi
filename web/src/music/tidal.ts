import * as auth from "@tidal-music/auth";
import * as EventProducer from "@tidal-music/event-producer";
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
const CLIENT_UNIQUE_KEY = "webnavi";
const SCOPES = ["user.read", "collection.read", "playlists.read", "playback", "recommendations.read", "search.read", "r_usr"];
/** A playlist's tracks come twenty a page; ten pages is plenty for a drive. */
const QUEUE_PAGES = 10;
/** What a list of tracks asks to have included, under its relationship [rel]. */
const TRACK_INCLUDE = (rel: string) => `${rel},${rel}.artists,${rel}.albums,${rel}.albums.coverArt`;
/** The kinds of mix TIDAL makes for the account. */
const MIXES = ["userDailyMixes", "userDiscoveryMixes", "userNewReleaseMixes"];
/** TIDAL's own reason when it hands over 30 seconds instead of the song. */
const PREVIEW_NOTE = "TIDAL 이 이 앱에는 30초 미리듣기만 허락합니다 (TIDAL 개발자 앱 등급 제한)";

type Resource = { id: string; type: string; attributes: Record<string, unknown>; relationships?: Record<string, { data?: { id: string }[] }> };
type Page = { data: { id: string; type: string }[] | { id: string; type: string }; included?: Resource[]; links?: { next?: string } };
const API = "https://openapi.tidal.com/v2";

interface Track {
  id: string;
  title: string;
  artist: string;
  art?: string;
  /** The cover small, for a row in a list. */
  small?: string;
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
  /** Songs from the last search, which a tap plays down from. */
  private found: Track[] = [];
  /** The list in its own order, for when shuffle is turned off again. */
  private ordered: Track[] = [];
  private shuffled = false;
  /** Bumped by every play, so a list still loading behind an old one stops. */
  private run = 0;
  /** The SDK's last failure, in words, until the next song starts. */
  private failure: string | undefined;
  /** TIDAL handed over 30 seconds of the song playing, not all of it. */
  private preview = false;
  private failedInRow = 0;
  /** Requests one after another, a little apart: TIDAL answers 429 to a burst. */
  private gate: Promise<unknown> = Promise.resolve();

  async connect(): Promise<void> {
    const first = await this.fetchToken();
    this.clientId = first.clientId;
    await auth.init({ clientId: this.clientId, clientUniqueKey: CLIENT_UNIQUE_KEY, credentialsStorageKey: "webnavi-tidal", scopes: SCOPES });
    await this.giveToken(first.token, first.expiresIn);
    Player.setCredentialsProvider(auth.credentialsProvider);
    // The SDK plays nothing without somewhere to report what was played (TIDAL pays artists by it):
    // TIDAL's own collector (through our server, which it answers), set up the way its embed player
    // does, with only the necessary events.
    if (!eventsStarted) {
      eventsStarted = true;
      await EventProducer.init({
        appInfo: { appName: "WebNavi", appVersion: "1" },
        blockedConsentCategories: { NECESSARY: false, PERFORMANCE: true, TARGETING: true },
        credentialsProvider: auth.credentialsProvider,
        platform: browserOf(navigator.userAgent),
        tlConsumerUri: `${location.origin}/api/music/tidal/events`,
        tlPublicConsumerUri: `${location.origin}/api/music/tidal/events/public`,
      });
    }
    Player.setEventSender({ sendEvent: EventProducer.sendEvent } as unknown as Parameters<typeof Player.setEventSender>[0]);
    Player.events.addEventListener("ended", () => void this.advance());
    Player.events.addEventListener("playback-state-change", ((e: CustomEvent<{ state: string }>) => {
      this.playing = e.detail.state === "PLAYING";
      this.emitNow();
    }) as EventListener);
    Player.events.addEventListener("media-product-transition", ((e: CustomEvent<{ playbackContext?: { actualAssetPresentation?: string } }>) => {
      this.preview = e.detail.playbackContext?.actualAssetPresentation === "PREVIEW";
      this.failure = undefined;
      this.failedInRow = 0;
      this.emitNow();
    }) as EventListener);
    // The SDK's own failures (a song not in this country, a subscription it needs, the network) as words.
    Player.events.addEventListener("error", ((e: CustomEvent<{ errorId?: string; errorCode?: string }>) => {
      this.failure = `TIDAL 재생 실패: ${playerError(e.detail.errorId)} (${e.detail.errorCode ?? "?"})`;
      this.emitNow();
      // A song that would not come is passed by, but not endlessly: three in a row and it waits for a tap.
      if (!this.playing && ++this.failedInRow <= 3 && this.queue[this.at + 1]) {
        const run = this.run;
        setTimeout(() => { if (run === this.run && !this.playing) void this.advance().catch(() => undefined); }, 1500);
      }
    }) as EventListener);
    Player.events.addEventListener("streaming-privileges-revoked", () => {
      this.failure = "다른 기기에서 TIDAL 을 재생해 여기서는 멈췄습니다";
      this.emitNow();
    });
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
   * What the list shows, each on its shelf: 좋아요한 곡, the account's own
   * playlists, the ones it has saved (TIDAL's editors' lists among them),
   * and the mixes TIDAL makes for it where the login allowed
   * recommendations.read. A shelf this login cannot see is left out.
   */
  async playlists(): Promise<Playlist[]> {
    const out: Playlist[] = [];
    const seen = new Set<string>();
    const add = (pages: Page[], group: string) => {
      const inc = included(pages);
      for (const d of pages.flatMap(dataOf)) {
        const p = d.type === "playlists" ? (inc.get(`playlists:${d.id}`) ?? (d as Resource)) : null;
        if (!p || seen.has(d.id)) continue;
        seen.add(d.id);
        const a = p.attributes ?? {};
        out.push({ id: d.id, name: String(a.name ?? a.title ?? d.id), uri: d.id, count: typeof a.numberOfItems === "number" ? a.numberOfItems : undefined, art: artOf(inc, p, "coverArt", 160), group });
      }
    };
    const shelf = async (path: string, max = 1) => { try { return await this.pages(path, max); } catch { return null; } };

    const liked = await shelf(`/userCollectionTracks/me/relationships/items?include=${TRACK_INCLUDE("items")}`);
    const likedTracks = liked ? this.tracksOf(liked) : [];
    if (likedTracks.length) out.push({ id: "likes", name: "좋아요한 곡", uri: "likes", art: likedTracks[0].art, group: "내 음악", sub: likedTracks.slice(0, 3).map((t) => t.title).join(" · ") });
    const mine = await shelf("/playlists?filter[owners.id]=me&include=coverArt", 3);
    if (mine) add(mine, "내 재생목록");
    const saved = await shelf("/userCollectionPlaylists/me/relationships/items?include=items,items.coverArt", 3);
    if (saved) add(saved, "저장한 재생목록");
    // The mixes TIDAL makes for the account come as playlists (empty until the login allows recommendations.read).
    for (const kind of MIXES) {
      const pages = await shelf(`/${kind}/me/relationships/items?include=items,items.coverArt`);
      if (pages) add(pages, "추천");
    }
    return out;
  }

  /**
   * Songs and playlists across all of TIDAL for [q]: the songs first
   * (tapping one plays from it down the found list), then playlists.
   */
  async search(q: string): Promise<Playlist[]> {
    const path = `/searchResults?filter[query]=${encodeURIComponent(q)}&include=${TRACK_INCLUDE("tracks")},playlists,playlists.coverArt`;
    const page = (await this.api(path)) as Page;
    const inc = included([page]);
    const result = dataOf(page)[0] as Resource | undefined;
    const ids = (rel: string) => result?.relationships?.[rel]?.data?.map((d) => d.id) ?? [];
    this.found = ids("tracks").map((id) => this.trackOf(inc, id));
    const out: Playlist[] = this.found.map((t) => ({ id: t.id, name: t.title, uri: `track:${t.id}`, art: t.small, group: "곡", sub: t.artist }));
    for (const id of ids("playlists")) {
      const p = inc.get(`playlists:${id}`);
      if (!p) continue;
      const a = p.attributes;
      out.push({ id, name: String(a.name ?? id), uri: id, count: typeof a.numberOfItems === "number" ? a.numberOfItems : undefined, art: artOf(inc, p, "coverArt", 160), group: "재생목록" });
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

  /** The tracks the pages list, with their artists and covers from what came included. */
  private tracksOf(pages: Page[]): Track[] {
    const inc = included(pages);
    return pages.flatMap(dataOf).filter((d) => d.type === "tracks").map((d) => this.trackOf(inc, d.id));
  }

  private trackOf(inc: Map<string, Resource>, id: string): Track {
    const t = inc.get(`tracks:${id}`);
    const artistIds = t?.relationships?.artists?.data?.map((a) => a.id) ?? [];
    const album = inc.get(`albums:${t?.relationships?.albums?.data?.[0]?.id}`);
    return {
      id,
      title: String(t?.attributes.title ?? id),
      artist: artistIds.map((a) => String(inc.get(`artists:${a}`)?.attributes.name ?? "")).filter(Boolean).join(", "),
      art: album ? artOf(inc, album, "coverArt", 300) : undefined,
      small: album ? artOf(inc, album, "coverArt", 80) : undefined,
      durationS: isoSeconds(t?.attributes.duration),
    };
  }

  /**
   * A playlist (a mix is one too), 좋아요한 곡, or a found song. Only the first page
   * of a long list is asked for before the music starts; the rest follow
   * slowly behind it, since TIDAL answers 429 to a quick run of pages.
   */
  async play(uri: string): Promise<void> {
    const run = ++this.run;
    if (uri.startsWith("track:")) {
      const id = uri.slice(6);
      const from = this.found.findIndex((t) => t.id === id);
      // The song tapped first, then the rest found (shuffled, if shuffle is on).
      this.ordered = from >= 0 ? this.found.slice(from) : [{ id, title: id, artist: "" }];
      this.queue = [this.ordered[0], ...(this.shuffled ? mixed(this.ordered.slice(1)) : this.ordered.slice(1))];
      this.at = -1;
      return this.advance();
    }
    const path = uri === "likes" ? `/userCollectionTracks/me/relationships/items?include=${TRACK_INCLUDE("items")}`
      : `/playlists/${uri}/relationships/items?include=${TRACK_INCLUDE("items")}`;
    const first = (await this.api(path)) as Page;
    this.ordered = this.tracksOf([first]);
    if (this.ordered.length === 0) throw new Error("이 목록에서 재생할 곡을 찾지 못했습니다");
    this.queue = this.shuffled ? mixed(this.ordered) : [...this.ordered];
    this.at = -1;
    await this.advance();
    void this.follow(first.links?.next, run);
  }

  /** The rest of a list, a page every couple of seconds, while it is still the one playing. */
  private async follow(next: string | undefined, run: number) {
    for (let n = 1; next && n < QUEUE_PAGES && run === this.run; n++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (run !== this.run) return;
      try {
        const page = (await this.api(next)) as Page;
        if (run !== this.run) return;
        const had = this.queue.length;
        const more = this.tracksOf([page]);
        this.ordered.push(...more);
        if (this.shuffled) {
          // Shuffled, the later pages go in anywhere after the song playing.
          for (const t of more) this.queue.splice(this.at + 1 + Math.floor(Math.random() * (this.queue.length - this.at)), 0, t);
          this.queueNext();
        } else {
          this.queue.push(...more);
          if (this.at === had - 1) this.queueNext(); // the last known song is playing: tell the SDK what follows
        }
        next = page.links?.next;
      } catch { return; } // the songs already here are enough to go on with
    }
  }

  /** The next song; one TIDAL will not hand over here (not in this country, say) is passed by, a few at most. */
  private async advance(skips = 0): Promise<void> {
    this.at++;
    const track = this.queue[this.at];
    if (!track) return;
    try {
      await Player.load({ productId: track.id, productType: "track", sourceId: "webnavi", sourceType: "PLAYLIST" }, 0);
      await Player.play();
    } catch (e) {
      if (skips < 5 && this.queue[this.at + 1]) return this.advance(skips + 1);
      throw e;
    }
    this.queueNext();
    this.emitNow();
  }

  /** On: the songs after this one in a random order. Off: the list's own order, from this song on. */
  async shuffle(on: boolean) {
    this.shuffled = on;
    const current = this.queue[this.at];
    if (!current) return;
    if (on) this.queue = [...this.queue.slice(0, this.at + 1), ...mixed(this.queue.slice(this.at + 1))];
    else {
      this.queue = [...this.ordered];
      this.at = Math.max(0, this.ordered.indexOf(current));
    }
    this.queueNext();
  }

  private queueNext() {
    const next = this.queue[this.at + 1];
    if (next) Player.setNext({ productId: next.id, productType: "track", sourceId: "webnavi", sourceType: "PLAYLIST" });
  }

  private emitNow() {
    const t = this.queue[this.at];
    let positionS: number | undefined;
    try { positionS = Player.getAssetPosition(); } catch { /* nothing loaded */ }
    // A preview is 30 seconds, whatever the song's own length.
    const durationS = this.preview ? Math.min(30, t?.durationS ?? 30) : t?.durationS;
    // A failure is told only while nothing plays: one about the song queued next is not this song's.
    const failed = !this.playing ? this.failure : undefined;
    const note = failed ?? (this.preview ? PREVIEW_NOTE : undefined);
    for (const l of this.listeners) l({ playing: this.playing, title: t?.title, artist: t?.artist, art: t?.art, positionS, durationS, note, noteBad: !!failed });
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
    this.run++;
  }

  /** One request to TIDAL's API, in turn; a 429 or a gateway error waits as long as TIDAL asks (or a few seconds) and tries again. */
  private api(path: string): Promise<unknown> {
    const go = this.gate.then(() => this.ask(path));
    this.gate = go.catch(() => undefined).then(() => new Promise((r) => setTimeout(r, 250)));
    return go;
  }

  private async ask(path: string): Promise<unknown> {
    const url = new URL(path.startsWith("/v2/") ? `https://openapi.tidal.com${path}` : `${API}${path}`);
    url.searchParams.set("countryCode", this.country);
    for (let attempt = 0; ; attempt++) {
      const { token } = await auth.credentialsProvider.getCredentials();
      const a = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.api+json" } });
      // 429: too quick; 502–504: TIDAL's gateway having a moment. Both pass if waited out.
      if ((a.status === 429 || (a.status >= 502 && a.status <= 504)) && attempt < 3) {
        const after = Number(a.headers.get("Retry-After"));
        await new Promise((r) => setTimeout(r, (after > 0 ? Math.min(after, 20) : 2 ** attempt * 2) * 1000));
        continue;
      }
      if (a.status === 429) throw new Error("TIDAL 이 잠시 요청을 막았습니다 (429). 조금 뒤에 다시 눌러 주세요");
      if (!a.ok) throw new Error(`TIDAL ${a.status} ${path.split("?")[0]}`);
      return a.json();
    }
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

/** [list] in a random order (Fisher–Yates), a new array. */
function mixed<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Once a page: the event producer keeps a single instance. */
let eventsStarted = false;

/** The browser's name, version and system, roughly, for the play reports. */
function browserOf(ua: string): { browserName: string; browserVersion: string; osName: string } {
  const chrome = /Chrome\/([\d.]+)/.exec(ua);
  return {
    browserName: chrome ? "Chrome" : "Browser",
    browserVersion: chrome?.[1] ?? "unknown",
    osName: /Tesla/.test(ua) ? "Tesla" : /Linux/.test(ua) ? "Linux" : /Mac OS/.test(ua) ? "Mac OS" : /Windows/.test(ua) ? "Windows" : "unknown",
  };
}

const dataOf = (p: Page) => (Array.isArray(p.data) ? p.data : p.data ? [p.data] : []);
const included = (pages: Page[]) => new Map(pages.flatMap((p) => p.included ?? []).map((i) => [`${i.type}:${i.id}`, i]));

/** The Player SDK's error ids, in words. */
function playerError(id?: string): string {
  switch (id) {
    case "PEContentNotAvailableForSubscription": return "이 구독으로는 들을 수 없는 곡";
    case "PEContentNotAvailableInLocation": return "이 나라에서는 들을 수 없는 곡";
    case "PEMonthlyStreamQuotaExceeded": return "이번 달 재생 한도를 넘었습니다";
    case "PENetwork": return "네트워크 오류";
    case "PENotAllowed": return "재생이 허락되지 않았습니다 (다시 연결이 필요할 수 있습니다)";
    case "PERetryable": return "잠시 뒤 다시 시도해 주세요";
    default: return "알 수 없는 오류";
  }
}
