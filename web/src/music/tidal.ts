import type { MusicSource, NowPlaying, Playlist } from "./source";

interface Track {
  id: string;
  title: string;
  artist: string;
  art?: string;
  small?: string;
  durationS?: number;
}

interface RawArtist {
  name?: string;
}

interface RawTrack {
  id: number | string;
  title?: string;
  duration?: number;
  artists?: RawArtist[];
  artist?: RawArtist;
  album?: { cover?: string };
}

interface RawMix {
  id?: string;
  title?: string;
  subTitle?: string;
  mixType?: string;
  images?: { SMALL?: { url?: string }; MEDIUM?: { url?: string }; LARGE?: { url?: string } };
}

interface RawPlaylistItem {
  uuid: string;
  title?: string;
  numberOfTracks?: number;
  image?: string;
}

/** The next track's stream is asked this long before the current one ends… */
const PREPARE_NEXT_S = 20;
/** …and used at the change if it is no older than this (TIDAL's addresses last longer). */
const STREAM_FRESH_MS = 5 * 60_000;

export class TidalSource implements MusicSource {
  readonly id = "tidal" as const;
  readonly label = "TIDAL";

  private audio: HTMLAudioElement;
  private listeners: ((now: NowPlaying) => void)[] = [];
  private queue: Track[] = [];
  private at = -1;
  private userId = "";
  private country = "KR";
  private playing = false;
  private found: Track[] = [];
  private ordered: Track[] = [];
  private shuffled = false;
  /** The listener's liked track ids (favorites/ids), for the heart on the player. */
  private liked = new Set<string>();
  private failure: string | undefined;
  private failedInRow = 0;
  /**
   * Between one track and the next: the element pauses as a track ends and as its source is changed, and a page
   * that said "paused" then let the car take its own sound back — the car's radio or app played for a second or
   * two before the next track (2026-10-04). Through the change the player stays "playing".
   */
  private switching = false;
  /** The next track's stream, asked a little before this one ends: no round trip to TIDAL at the change. */
  private nextStream: { id: string; url: string; at: number } | null = null;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = "auto";

    this.audio.addEventListener("ended", () => {
      this.switching = true;
      void this.advance();
    });

    this.audio.addEventListener("playing", () => {
      this.switching = false;
      this.playing = true;
      this.failure = undefined;
      this.failedInRow = 0;
      this.emitNow();
    });

    this.audio.addEventListener("pause", () => {
      // The pause of a track ending, or of its source changed for the next: not the listener's.
      if (this.switching || this.audio.ended) return;
      this.playing = false;
      this.emitNow();
    });

    this.audio.addEventListener("timeupdate", () => {
      const left = this.audio.duration - this.audio.currentTime;
      if (Number.isFinite(left) && left < PREPARE_NEXT_S) void this.prepareNext();
      this.emitNow();
    });

    this.audio.addEventListener("error", () => {
      // The source let go (disconnect): no track failed.
      if (this.queue.length === 0) return;
      this.failure = "TIDAL 재생 오류가 발생했습니다";
      // A fault mid-track stops the sound with no pause event: not "playing" any more, and the fault shown.
      if (this.audio.paused || this.audio.error) { this.switching = false; this.playing = false; }
      this.emitNow();
      // Moved on only if nothing else has by then: a play() refused for the same fault moves on itself (advance),
      // and this must not skip the track that one put on.
      const load = this.load;
      if (!this.playing && ++this.failedInRow <= 3 && this.queue[this.at + 1]) {
        setTimeout(() => {
          if (!this.playing && load === this.load) void this.advance().catch(() => undefined);
        }, 1500);
      }
    });
  }

  async connect(): Promise<void> {
    const res = await fetch("/api/music/tidal/token");
    const info = (await res.json().catch(() => ({}))) as {
      token?: string;
      userId?: string;
      countryCode?: string;
      error?: string;
    };

    if (!res.ok || !info.token) {
      throw new Error(info.error ?? `TIDAL 연결 실패 (${res.status})`);
    }

    this.userId = info.userId || "";
    this.country = info.countryCode || "KR";

    if (!this.userId) {
      const meRes = await this.v1Api("/users/me").catch(() => null);
      if (meRes && typeof meRes === "object") {
        const anyMe = meRes as { userId?: string | number; id?: string | number; countryCode?: string };
        this.userId = String(anyMe.userId ?? anyMe.id ?? "");
        if (anyMe.countryCode) this.country = anyMe.countryCode;
      }
    }
  }

  async playlists(): Promise<Playlist[]> {
    const out: Playlist[] = [];

    // 1. Favorites (좋아요한 곡), the latest liked first
    if (this.userId) {
      void this.loadLikedIds();
      try {
        const likedRes = (await this.v1Api(`/users/${this.userId}/favorites/tracks?limit=50&order=DATE&orderDirection=DESC`)) as {
          items?: { item: RawTrack }[];
        };
        const likedTracks = (likedRes?.items ?? []).map((i) => trackOf(i.item));
        if (likedTracks.length) {
          out.push({
            id: "likes",
            name: "좋아요한 곡",
            uri: "likes",
            art: likedTracks[0].art,
            group: "내 음악",
            sub: likedTracks.slice(0, 3).map((t) => t.title).join(" · "),
          });
        }
      } catch {
        /* skip */
      }

      // 2. 내가 만든 재생목록
      try {
        const myPlaylists = (await this.v1Api(`/users/${this.userId}/playlists?limit=50`)) as {
          items?: RawPlaylistItem[];
        };
        for (const p of myPlaylists?.items ?? []) {
          out.push({
            id: p.uuid,
            name: String(p.title ?? p.uuid),
            uri: p.uuid,
            count: typeof p.numberOfTracks === "number" ? p.numberOfTracks : undefined,
            art: imgUrl(p.image, 320),
            group: "내가 만든 재생목록",
          });
        }
      } catch {
        /* skip */
      }

      // 3. 저장한 재생목록: others' (TIDAL's, other listeners') put in the collection
      try {
        const favPlaylists = (await this.v1Api(`/users/${this.userId}/favorites/playlists?limit=50`)) as {
          items?: { item: RawPlaylistItem }[];
        };
        for (const i of favPlaylists?.items ?? []) {
          const p = i.item;
          if (!p) continue;
          out.push({
            id: p.uuid,
            name: String(p.title ?? p.uuid),
            uri: p.uuid,
            count: typeof p.numberOfTracks === "number" ? p.numberOfTracks : undefined,
            art: imgUrl(p.image, 320),
            group: "저장한 재생목록 (다른 사람 · TIDAL 것)",
          });
        }
      } catch {
        /* skip */
      }
    }

      // 4. TIDAL's mixes for this listener: My Daily Discovery, My Mix 1, 2, 3 … (the page the app's 홈 shows)
      try {
        const page = (await this.v1Api(`/pages/my_collection_my_mixes?deviceType=BROWSER`)) as {
          rows?: { modules?: { type?: string; pagedList?: { items?: RawMix[] }; items?: RawMix[] }[] }[];
        };
        for (const row of page?.rows ?? []) {
          for (const m of row.modules ?? []) {
            for (const mix of m.pagedList?.items ?? m.items ?? []) {
              if (!mix?.id) continue;
              out.push({
                id: `mix:${mix.id}`,
                name: String(mix.title ?? "믹스"),
                uri: `mix:${mix.id}`,
                art: mix.images?.MEDIUM?.url ?? mix.images?.SMALL?.url,
                group: "TIDAL 추천",
                sub: mix.subTitle,
              });
            }
          }
        }
      } catch {
        /* no mixes page: the rest still comes */
      }


    return out;
  }

  async search(q: string): Promise<Playlist[]> {
    const out: Playlist[] = [];
    const res = (await this.v1Api(`/search?query=${encodeURIComponent(q)}&limit=30&types=TRACKS,PLAYLISTS`)) as {
      tracks?: { items?: RawTrack[] };
      playlists?: { items?: RawPlaylistItem[] };
    };

    const trackItems = res?.tracks?.items ?? [];
    this.found = trackItems.map(trackOf);

    for (const t of this.found) {
      out.push({
        id: t.id,
        name: t.title,
        uri: `track:${t.id}`,
        art: t.small,
        group: "곡",
        sub: t.artist,
      });
    }

    for (const p of res?.playlists?.items ?? []) {
      out.push({
        id: p.uuid,
        name: String(p.title ?? p.uuid),
        uri: p.uuid,
        count: typeof p.numberOfTracks === "number" ? p.numberOfTracks : undefined,
        art: imgUrl(p.image, 160),
        group: "재생목록",
      });
    }

    return out;
  }

  async play(uri: string): Promise<void> {
    // Two lists tapped in a row: the first's answer, coming second, must not take the queue from the second.
    const load = ++this.load;
    if (uri.startsWith("track:")) {
      const id = uri.slice(6);
      const from = this.found.findIndex((t) => t.id === id);
      this.ordered = from >= 0 ? this.found.slice(from) : [{ id, title: id, artist: "" }];
      this.queue = [this.ordered[0], ...(this.shuffled ? mixed(this.ordered.slice(1)) : this.ordered.slice(1))];
      this.at = -1;
      return this.advance();
    }

    if (uri === "likes") {
      const res = (await this.v1Api(`/users/${this.userId}/favorites/tracks?limit=100&order=DATE&orderDirection=DESC`)) as {
        items?: { item: RawTrack }[];
      };
      this.ordered = (res?.items ?? []).map((i) => trackOf(i.item));
    } else if (uri.startsWith("mix:")) {
      const res = (await this.v1Api(`/mixes/${encodeURIComponent(uri.slice(4))}/items?limit=100`)) as {
        items?: { item: RawTrack }[];
      };
      this.ordered = (res?.items ?? []).map((i) => trackOf(i.item));
    } else {
      const res = (await this.v1Api(`/playlists/${uri}/tracks?limit=100`)) as {
        items?: RawTrack[];
      };
      this.ordered = (res?.items ?? []).map(trackOf);
    }

    // Another list was asked for while this one's came: this one is not played.
    if (load !== this.load) return;
    if (this.ordered.length === 0) {
      throw new Error("재생할 곡을 찾지 못했습니다");
    }

    this.queue = this.shuffled ? mixed(this.ordered) : [...this.ordered];
    this.at = -1;
    await this.advance();
  }

  /** Each load of a track counts up: a play() left waiting by a newer load is that load's business, not a failure. */
  private load = 0;

  private async advance(skips = 0): Promise<void> {
    this.at++;
    const track = this.queue[this.at];
    if (!track) {
      this.switching = false;
      this.playing = false;
      this.emitNow();
      return;
    }

    const load = ++this.load;
    this.switching = true;
    const ready = this.nextStream?.id === track.id && Date.now() - this.nextStream.at < STREAM_FRESH_MS ? this.nextStream.url : null;
    try {
      this.nextStream = null;
      this.audio.src = ready ?? `/api/music/tidal/track/${encodeURIComponent(track.id)}/audio`;
      await this.audio.play();
      if (load !== this.load) return;
      this.failure = undefined;
    } catch (e) {
      if (load === this.load) this.switching = false;
      // A newer load took the element (the next button twice): its play() is the one that counts. Taking this
      // for a failure skipped a track for each tap, the two chains interrupting each other.
      if (load !== this.load || (e as Error)?.name === "AbortError") return;
      // The address asked ahead refused (gone stale): the same track by the usual way, not a skip.
      if (ready) {
        this.at--;
        return this.advance(skips);
      }
      if (skips < 3 && this.queue[this.at + 1]) {
        return this.advance(skips + 1);
      }
      this.failure = "재생 실패: 다음 곡으로 넘어갈 수 없습니다";
      this.playing = false;
      this.emitNow();
      throw e;
    }

    this.emitNow();
  }

  /** The next track's stream address, once a track (it is TIDAL's own, good for some minutes). */
  private async prepareNext(): Promise<void> {
    const next = this.queue[this.at + 1];
    if (!next || this.nextStream?.id === next.id || this.preparing === next.id) return;
    this.preparing = next.id;
    try {
      const res = await fetch(`/api/music/tidal/track/${encodeURIComponent(next.id)}/stream`);
      const body = (await res.json().catch(() => ({}))) as { url?: string };
      if (res.ok && body.url && this.queue[this.at + 1]?.id === next.id) this.nextStream = { id: next.id, url: body.url, at: Date.now() };
    } catch {
      /* asked at the change instead */
    } finally {
      this.preparing = null;
    }
  }
  private preparing: string | null = null;

  async shuffle(on: boolean): Promise<void> {
    this.shuffled = on;
    const current = this.queue[this.at];
    if (!current) return;
    if (on) {
      this.queue = [...this.queue.slice(0, this.at + 1), ...mixed(this.queue.slice(this.at + 1))];
    } else {
      this.queue = [...this.ordered];
      this.at = Math.max(0, this.ordered.indexOf(current));
    }
  }

  async seek(seconds: number): Promise<void> {
    this.audio.currentTime = Math.max(0, seconds);
    this.emitNow();
  }

  async toggle(): Promise<void> {
    if (this.playing) {
      // Paused while the next track was being put on: the listener's pause, not the change's — reported.
      this.switching = false;
      this.audio.pause();
      if (this.audio.paused && this.playing) { this.playing = false; this.emitNow(); }
    } else {
      await this.audio.play();
    }
  }

  async next(): Promise<void> {
    await this.advance();
  }

  async previous(): Promise<void> {
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      this.emitNow();
      return;
    }
    this.at = Math.max(-1, this.at - 2);
    await this.advance();
  }

  setVolume(level: number): void {
    this.audio.volume = Math.max(0, Math.min(1, level));
  }

  onState(listener: (now: NowPlaying) => void): void {
    // Once each: the page hands the same one over again whenever this source is picked.
    if (!this.listeners.includes(listener)) this.listeners.push(listener);
  }

  disconnect(): void {
    this.load++;
    this.audio.pause();
    this.queue = [];
    // The attribute removed, not set to "": an empty src is an error event (MEDIA_ERR_SRC_NOT_SUPPORTED).
    this.audio.removeAttribute("src");
    this.audio.load();
    this.at = -1;
    this.playing = false;
    this.emitNow();
  }

  private emitNow(): void {
    const t = this.queue[this.at];
    const positionS = this.audio.currentTime;
    const durationS = this.audio.duration && !isNaN(this.audio.duration) ? this.audio.duration : t?.durationS;
    const note = !this.playing ? this.failure : undefined;

    for (const l of this.listeners) {
      l({
        playing: this.playing,
        title: t?.title,
        artist: t?.artist,
        art: t?.art,
        positionS,
        durationS,
        note,
        trackId: t?.id,
        liked: t ? this.liked.has(t.id) : undefined,
        noteBad: !!this.failure,
      });
    }
  }

  /** The listener's liked track ids, once (and again after a like): the heart on the player. */
  private async loadLikedIds(): Promise<void> {
    try {
      const ids = (await this.v1Api(`/users/${this.userId}/favorites/ids`)) as { TRACK?: (string | number)[] };
      this.liked = new Set((ids?.TRACK ?? []).map(String));
      this.emitNow();
    } catch {
      /* no heart, then */
    }
  }

  /** The track playing liked, or unliked: TIDAL's favorites, and the heart at once. */
  async like(on: boolean): Promise<void> {
    const t = this.queue[this.at];
    if (!t || !this.userId) return;
    const res = await fetch(`/api/music/tidal/v1/users/${this.userId}/favorites/tracks${on ? "" : `/${encodeURIComponent(t.id)}`}`, {
      method: on ? "POST" : "DELETE",
      headers: on ? { "Content-Type": "application/x-www-form-urlencoded" } : {},
      body: on ? `trackIds=${encodeURIComponent(t.id)}&onArtifactNotFound=FAIL` : undefined,
    });
    if (!res.ok) throw new Error(`좋아요 실패 (${res.status})`);
    if (on) this.liked.add(t.id); else this.liked.delete(t.id);
    this.emitNow();
  }

  private async v1Api(path: string): Promise<unknown> {
    const cleanPath = path.startsWith("/") ? path.slice(1) : path;
    const res = await fetch(`/api/music/tidal/v1/${cleanPath}`);
    if (!res.ok) {
      throw new Error(`TIDAL API 오류 (${res.status})`);
    }
    return res.json();
  }
}

function imgUrl(hash?: string, size = 320): string | undefined {
  if (!hash) return undefined;
  return `https://resources.tidal.com/images/${hash.replace(/-/g, "/")}/${size}x${size}.jpg`;
}

function trackOf(raw: RawTrack): Track {
  const id = String(raw?.id ?? "");
  const title = String(raw?.title ?? id);
  const artist =
    raw?.artists
      ?.map((a) => a.name)
      .filter(Boolean)
      .join(", ") ||
    raw?.artist?.name ||
    "";
  const cover = raw?.album?.cover;
  return {
    id,
    title,
    artist,
    art: imgUrl(cover, 320),
    small: imgUrl(cover, 80),
    durationS: typeof raw?.duration === "number" ? raw.duration : undefined,
  };
}

function mixed<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
