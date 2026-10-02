import type { FastifyInstance } from "fastify";
import type { Db } from "./db.js";
import type { KakaoSearch, Place } from "./search.js";
import type { LonLat } from "./route/types.js";

/**
 * A place sent from a phone (/share, the share sheet of 네이버 지도,
 * 카카오맵, 티맵): read from the text the app shares, found again on
 * Kakao's search, and kept a day for the account it was sent to — whose
 * car shows it at the top of 목적지.
 */

/** What an app's share text says: the place's name, its address if given, the links in it. */
export interface ShareText { name: string | null; address: string | null; urls: string[] }

const URL_RE = /https?:\/\/[^\s<>"']+/g;
/** An address's start: a 시·도, as the apps write them. */
const ADDRESS_RE = /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|충청|전북|전남|전라|경북|경남|경상|제주)\S*\s+\S+/;
/** The app's own tag before the place: "[네이버지도]", "[카카오맵]", "[TMAP]". */
const TAG_RE = /^\s*\[[^\]]{1,20}\]\s*/;

/** A shared way, not a place: "출발 → 도착 (자동차 길찾기)". The place is where it ends. */
const ROUTE_ARROW = /\s*(?:→|->|➡|⇒)\s*/;
/** The kind of way said after it: "(자동차 길찾기)", "(대중교통 길찾기)". */
const ROUTE_KIND = /\s*\([^)]*(길찾기|경로|route)[^)]*\)\s*$/i;

export function readShare(text: string): ShareText {
  const urls = [...text.matchAll(URL_RE)].map((m) => m[0].replace(/[),.]+$/, ""));
  const lines = text.replace(URL_RE, "\n").split(/\r?\n/).map((l) => l.replace(TAG_RE, "").trim()).filter(Boolean)
    // A way shared: only its end is the place to go (its start is where the sender was).
    .map((l) => (ROUTE_ARROW.test(l) ? l.split(ROUTE_ARROW).pop()!.replace(ROUTE_KIND, "").trim() : l.replace(ROUTE_KIND, "").trim()))
    .filter(Boolean);
  let name: string | null = null, address: string | null = null;
  for (const line of lines) {
    // "이름 서울 강남구 …" on one line: split where the address starts.
    const at = line.search(/\s(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)\S*\s/);
    if (!address && ADDRESS_RE.test(line)) { address = line; continue; }
    if (!name && at > 0 && !address) { name = line.slice(0, at).trim(); address = line.slice(at + 1).trim(); continue; }
    if (!name) name = line;
  }
  return { name, address, urls };
}

/** The links followed for a place's coordinates: the apps' own, and nothing else (the server does not fetch whatever it is sent). */
const FOLLOWED = /^(naver\.me|map\.naver\.com|m\.map\.naver\.com|m\.place\.naver\.com|kko\.to|kko\.kakao\.com|applink\.map\.kakao\.com|place\.map\.kakao\.com|map\.kakao\.com|m\.map\.kakao\.com|tmap\.life|surl\.tmap\.co\.kr|surl\.tmapmobility\.com|poi\.tmobiweb\.com|poi\.tmap\.co\.kr|www\.tmap\.co\.kr)$/;
/** A link of 티맵's: its pages carry no place without the app's own key, so the words shared with it are what there is. */
const TMAP_HOST = /(^|\.)(tmap\.life|tmap\.co\.kr|tmapmobility\.com|tmobiweb\.com)$/;

/** A 카카오맵 place's id in any of the addresses its share link goes through (kko.to → applink…/place?id=, place.map.kakao.com/…). */
export function kakaoPlaceId(url: string): string | null {
  return url.match(/applink\.map\.kakao\.com\/place\?(?:[^#]*&)?id=(\d+)/)?.[1] ?? url.match(/place\.map\.kakao\.com\/(?:m\/)?(\d+)/)?.[1] ?? null;
}

/**
 * A 카카오맵 place as its own public page tells link previews: og:title the
 * name, og:description the address, the preview map's marker (srs=wgs84,
 * m=lon,lat) the place.
 */
export function kakaoPlaceOf(html: string): { name: string; address: string; at: LonLat } | null {
  const meta = (key: string) => html.match(new RegExp(`<meta[^>]+(?:property|name)="${key}"[^>]+content="([^"]*)"`))?.[1]?.trim() ?? null;
  const name = meta("og:title"), address = meta("og:description") ?? "", image = meta("twitter:image") ?? meta("og:image") ?? "";
  const m = decodeURIComponent(image.match(/[?&]m=([^&]+)/)?.[1] ?? "").split(",").map(Number);
  if (!name || name === "카카오맵" || m.length !== 2 || !m.every(Number.isFinite) || !/srs=wgs84/.test(image)) return null;
  const at: LonLat = [m[0], m[1]];
  if (at[0] < 124 || at[0] > 132 || at[1] < 33 || at[1] > 39) return null;
  return { name, address, at };
}

async function kakaoPlace(id: string): Promise<{ name: string; address: string; at: LonLat } | null> {
  // The page answers a desktop browser; a phone's is refused.
  const a = await fetch(`https://place.map.kakao.com/${id}`, { headers: { "User-Agent": DESKTOP_UA }, signal: AbortSignal.timeout(4000) }).catch(() => null);
  return a?.ok ? kakaoPlaceOf(await a.text()) : null;
}
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** Coordinates a link's address gives outright (lng=…&lat=…, in Korea), if it does. */
export function coordsOf(url: string): LonLat | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const num = (k: string) => { const v = Number(u.searchParams.get(k)); return Number.isFinite(v) && v !== 0 ? v : null; };
  const lon = num("lng") ?? num("lon") ?? num("x") ?? num("longitude"), lat = num("lat") ?? num("y") ?? num("latitude");
  if (lon != null && lat != null && lon > 124 && lon < 132 && lat > 33 && lat < 39) return [lon, lat];
  // 카카오맵's shared way: its end as "ep=lat,lng" (m.map.kakao.com/scheme/route?ep=37.54,126.95&en=…).
  const ep = (u.searchParams.get("ep") ?? "").split(",").map(Number);
  if (ep.length === 2 && ep.every(Number.isFinite) && ep[1] > 124 && ep[1] < 132 && ep[0] > 33 && ep[0] < 39) return [ep[1], ep[0]];
  return null;
}

/** [url] and the addresses it redirects to (its own apps' hosts only), up to a few hops. */
async function follow(url: string): Promise<string[]> {
  const seen: string[] = [];
  let at = url;
  for (let hop = 0; hop < 5; hop++) {
    let host: string;
    try { host = new URL(at).hostname; } catch { break; }
    if (!FOLLOWED.test(host)) break;
    seen.push(at);
    const a = await fetch(at, { redirect: "manual", signal: AbortSignal.timeout(4000) }).catch(() => null);
    const next = a?.headers.get("location");
    if (!a || a.status < 300 || a.status >= 400 || !next) break;
    at = new URL(next, at).toString();
  }
  if (!seen.includes(at)) seen.push(at);
  return seen;
}

/** Words of an address worth matching on: the road or 동 and the number. */
function addressWords(address: string): string[] {
  return address.replace(/[(),]/g, " ").split(/\s+/).filter((w) => /\d|로$|길$|동$|리$/.test(w));
}

/**
 * The place a share text means: Kakao's answer for its name that agrees
 * with its address (or with the link's coordinates); its address alone
 * when there is no name to look for.
 */
export async function resolveShare(text: string, search: Pick<KakaoSearch, "find" | "findAddress">): Promise<Place | null> {
  const read = readShare(text);
  let near: LonLat | null = null;
  for (const url of read.urls.slice(0, 2)) {
    for (const hop of await follow(url).catch(() => [url])) {
      // A 카카오맵 link: its place's own page, exactly.
      const id = kakaoPlaceId(hop);
      if (id) { const p = await kakaoPlace(id); if (p) return p; }
      near = coordsOf(hop) ?? near;
      if (near) break;
    }
    if (near) break;
  }
  const query = read.name ?? read.address;
  if (!query) return null;
  const found = await search.find(query, near ?? undefined).catch(() => [] as Place[]);
  const words = read.address ? addressWords(read.address) : [];
  const score = (p: Place) => {
    const agree = words.filter((w) => p.address.includes(w)).length;
    const close = near ? -Math.hypot(p.at[0] - near[0], p.at[1] - near[1]) * 1000 : 0;
    return agree * 10 + close;
  };
  const best = found.length ? found.reduce((a, b) => (score(b) > score(a) ? b : a)) : null;
  if (best && (words.length === 0 || words.some((w) => best.address.includes(w)) || near)) return { ...best, name: read.name ?? best.name };
  // No name Kakao knows: the address itself.
  if (read.address) {
    const at = await search.findAddress(read.address).catch(() => null);
    if (at) return { name: read.name ?? read.address, address: read.address, at };
  }
  if (near) return { name: read.name ?? "공유받은 위치", address: read.address ?? "", at: near };
  return best;
}

const ok = (p: unknown): p is LonLat => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v));

export function registerShare(app: FastifyInstance, db: Db, search: KakaoSearch) {
  // Who a place can be sent to: every account on this server (its owner made them all).
  app.get("/api/share/users", async (request) => ({ me: request.user!.name, users: db.users().map((u) => u.name) }));

  app.post<{ Body: { text?: string } }>("/api/share/resolve", async (request, reply) => {
    const text = typeof request.body?.text === "string" ? request.body.text.slice(0, 2000) : "";
    if (!text.trim()) return reply.code(400).send({ error: "text" });
    if (!search.ready) return reply.code(503).send({ error: "search has no key on this server" });
    const place = await resolveShare(text, search);
    if (place) return { place };
    // 티맵's link alone: nothing to find it by.
    const read = readShare(text);
    const onlyTmap = !read.name && !read.address && read.urls.some((u) => { try { return TMAP_HOST.test(new URL(u).hostname); } catch { return false; } });
    return reply.code(404).send({ error: onlyTmap ? "티맵 링크만으로는 장소를 알 수 없어요 — 장소 이름이나 주소를 같이 붙여 주세요" : "장소를 찾지 못했어요" });
  });

  app.post<{ Body: { to?: string; place?: { name?: string; address?: string; at?: unknown } } }>("/api/share/send", async (request, reply) => {
    const to = db.users().find((u) => u.name.toLowerCase() === String(request.body?.to ?? "").toLowerCase());
    const p = request.body?.place;
    if (!to || !p || typeof p.name !== "string" || !ok(p.at)) return reply.code(400).send({ error: "to and place" });
    db.share(to.id, request.user!.id, { name: p.name.slice(0, 120), address: String(p.address ?? "").slice(0, 200), at: p.at });
    return { ok: true, to: to.name };
  });

  app.get("/api/share/inbox", async (request) => ({ places: db.inbox(request.user!.id, Date.now() - KEEP_MS) }));

  app.post<{ Body: { id?: number } }>("/api/share/dismiss", async (request, reply) => {
    if (!Number.isInteger(request.body?.id)) return reply.code(400).send({ error: "id" });
    db.dismissShared(request.user!.id, request.body!.id!);
    return { ok: true };
  });
}

/** A sent place is kept this long. */
export const KEEP_MS = 24 * 3600_000;
