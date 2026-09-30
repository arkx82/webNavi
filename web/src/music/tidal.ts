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

interface RawPlaylistItem {
  uuid: string;
  title?: string;
  numberOfTracks?: number;
  image?: string;
}

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
  private failure: string | undefined;
  private failedInRow = 0;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = "auto";

    this.audio.addEventListener("ended", () => {
      void this.advance();
    });

    this.audio.addEventListener("playing", () => {
      this.playing = true;
      this.failure = undefined;
      this.failedInRow = 0;
      this.emitNow();
    });

    this.audio.addEventListener("pause", () => {
      this.playing = false;
      this.emitNow();
    });

    this.audio.addEventListener("timeupdate", () => {
      this.emitNow();
    });

    this.audio.addEventListener("error", () => {
      this.failure = "TIDAL 재생 오류가 발생했습니다";
      this.emitNow();
      if (!this.playing && ++this.failedInRow <= 3 && this.queue[this.at + 1]) {
        setTimeout(() => {
          if (!this.playing) void this.advance().catch(() => undefined);
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

    // 1. Favorites (좋아요한 곡)
    if (this.userId) {
      try {
        const likedRes = (await this.v1Api(`/users/${this.userId}/favorites/tracks?limit=50`)) as {
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

      // 2. 내 재생목록
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
            group: "내 재생목록",
          });
        }
      } catch {
        /* skip */
      }

      // 3. 저장한 재생목록
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
            group: "저장한 재생목록",
          });
        }
      } catch {
        /* skip */
      }
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
    if (uri.startsWith("track:")) {
      const id = uri.slice(6);
      const from = this.found.findIndex((t) => t.id === id);
      this.ordered = from >= 0 ? this.found.slice(from) : [{ id, title: id, artist: "" }];
      this.queue = [this.ordered[0], ...(this.shuffled ? mixed(this.ordered.slice(1)) : this.ordered.slice(1))];
      this.at = -1;
      return this.advance();
    }

    if (uri === "likes") {
      const res = (await this.v1Api(`/users/${this.userId}/favorites/tracks?limit=100`)) as {
        items?: { item: RawTrack }[];
      };
      this.ordered = (res?.items ?? []).map((i) => trackOf(i.item));
    } else {
      const res = (await this.v1Api(`/playlists/${uri}/tracks?limit=100`)) as {
        items?: RawTrack[];
      };
      this.ordered = (res?.items ?? []).map(trackOf);
    }

    if (this.ordered.length === 0) {
      throw new Error("재생할 곡을 찾지 못했습니다");
    }

    this.queue = this.shuffled ? mixed(this.ordered) : [...this.ordered];
    this.at = -1;
    await this.advance();
  }

  private async advance(skips = 0): Promise<void> {
    this.at++;
    const track = this.queue[this.at];
    if (!track) {
      this.playing = false;
      this.emitNow();
      return;
    }

    try {
      this.audio.src = `/api/music/tidal/track/${encodeURIComponent(track.id)}/audio`;
      await this.audio.play();
      this.failure = undefined;
    } catch (e) {
      if (skips < 3 && this.queue[this.at + 1]) {
        return this.advance(skips + 1);
      }
      this.failure = "재생 실패: 다음 곡으로 넘어갈 수 없습니다";
      throw e;
    }

    this.emitNow();
  }

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
      this.audio.pause();
    } else {
      await this.audio.play();
    }
  }

  async next(): Promise<void> {
    await this.advance();
  }

  async previous(): Promise<void> {
    this.at = Math.max(-1, this.at - 2);
    await this.advance();
  }

  setVolume(level: number): void {
    this.audio.volume = Math.max(0, Math.min(1, level));
  }

  onState(listener: (now: NowPlaying) => void): void {
    this.listeners.push(listener);
  }

  disconnect(): void {
    this.audio.pause();
    this.audio.src = "";
    this.queue = [];
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
        noteBad: !!this.failure,
      });
    }
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
