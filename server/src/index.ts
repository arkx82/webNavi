import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Tmap } from "./route/tmap.js";
import { Kakao } from "./route/kakao.js";
import { Naver } from "./route/naver.js";
import { Osrm } from "./route/osrm.js";
import { ProviderError, type LonLat, type Provider, type RouteProvider } from "./route/types.js";
import { SafetyIndex } from "./safety/index.js";
import { CAMERAS_MAX_AGE_MS, fetchCameras, keptCameras } from "./safety/cameras.js";
import { Hotspots } from "./safety/hotspots.js";
import { KakaoSearch } from "./search.js";
import { CATEGORIES, FUELS, Nearby, type Category, type Fuel } from "./nearby/index.js";
import { NearbyError } from "./nearby/util.js";
import { Speaker, isMadeVoice, prerender } from "./tts.js";
import { MadeVoices, SYSTEM_VOICES } from "./voices.js";
import { Readable } from "node:stream";
import { Settings } from "./settings.js";
import { registerAdmin } from "./admin.js";
import { registerMusic } from "./music.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const env = process.env;

const app = Fastify({ logger: { level: env.LOG_LEVEL ?? "info" } });

// The keys live here and nowhere else: the car's browser only ever sees
// this server. They are read at every call, so a key typed on /admin is
// in force at once; a provider without one is simply not offered.
const settings = new Settings(env.CONFIG_DIR ?? join(root, "config"));
const providers: Record<Provider, RouteProvider> = {
  tmap: new Tmap(settings.reader("tmapAppKey")),
  kakao: new Kakao(settings.reader("kakaoRestKey")),
  naver: new Naver(settings.reader("naverClientId"), settings.reader("naverClientSecret")),
  // OpenStreetMap roads with no key and no traffic: the desk's provider,
  // and the road under the demo. Left out of "all" when a real one answers.
  osrm: new Osrm(),
};

const search = new KakaoSearch(settings.reader("kakaoRestKey"));
const nearby = new Nearby({
  kakao: settings.reader("kakaoRestKey"),
  tmap: settings.reader("tmapAppKey"),
  opinet: settings.reader("opinetKey"),
  dataGoKr: settings.reader("dataGoKrKey"),
  evTariffs: settings.reader("evTariffs"),
});

const dataDir = env.DATA_DIR ?? join(root, "data");
// CSVs dropped in by hand (speed bumps, or cameras from a file), plus the
// national camera list from data.go.kr's API, kept in the config volume
// and asked again weekly. The index is rebuilt whole when that comes.
const configDir = env.CONFIG_DIR ?? join(root, "config");
let cameras = keptCameras(configDir);
let safety = buildSafety();
function buildSafety(): SafetyIndex {
  const index = SafetyIndex.fromDirectory(dataDir);
  if (cameras) index.add(cameras.features).build();
  return index;
}
app.log.info({ features: safety.features.length, cameras: cameras?.features.length ?? 0, dataDir }, "safety index built");
const hotspots = new Hotspots(settings.reader("dataGoKrKey"), (at) => nearby.ev.districtOf(at));
let camerasError: string | null = null;
async function refreshCameras() {
  const key = settings.get("dataGoKrKey");
  if (!key || (cameras && Date.now() - cameras.at < CAMERAS_MAX_AGE_MS)) return;
  try {
    cameras = await fetchCameras(key, configDir);
    safety = buildSafety();
    camerasError = null;
    app.log.info({ cameras: cameras.features.length }, "cameras fetched");
  } catch (e) {
    camerasError = (e as Error).message;
    app.log.warn({ err: camerasError }, "cameras: not fetched");
  }
}

app.get("/api/health", async () => ({
  ok: true,
  providers: Object.fromEntries(Object.values(providers).map((p) => [p.name, p.ready])),
  safetyFeatures: safety.features.length,
  search: search.ready,
  tts: speaker.ready,
  nearby: nearby.sources(),
  map: { tmap: providers.tmap.ready, naver: !!settings.get("naverClientId") },
}));

/**
 * Kakao's refusals, in words the owner can act on: an app made without the
 * map and local service switched on answers every search with a 403.
 */
function plain(message: string): string {
  if (/OPEN_MAP_AND_LOCAL/.test(message)) return "카카오: 앱에서 '카카오맵' 사용 설정이 꺼져 있습니다 (developers.kakao.com → 내 애플리케이션 → 카카오맵 → 사용 설정 ON)";
  return message;
}

// TMAP's vector map for the page, when there is a TMAP key: its loader,
// fetched here so the page need not know the key's name. The loader goes
// on to document.write the SDK, so the page includes this as a plain
// blocking script. Without a key it is an empty script and the page keeps
// the OpenStreetMap ground.
let tmapLoader: { key: string; at: number; js: string } | null = null;
app.get("/api/map/tmap.js", async (_request, reply) => {
  reply.type("text/javascript; charset=utf-8").header("Cache-Control", "no-store");
  const key = settings.get("tmapAppKey");
  if (!key) return "/* no TMAP key: the page keeps the OpenStreetMap ground */";
  if (tmapLoader?.key === key && Date.now() - tmapLoader.at < 3600_000) return tmapLoader.js;
  try {
    const answer = await fetch(`https://apis.openapi.sk.com/tmap/vectorjs?version=1&appKey=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(4000) });
    const js = await answer.text();
    if (!answer.ok || js.trimStart().startsWith("{")) throw new Error(js.slice(0, 200));
    tmapLoader = { key, at: Date.now(), js };
    return js;
  } catch (e) {
    app.log.warn({ err: (e as Error).message }, "tmap loader");
    return `/* TMAP loader unavailable: ${String((e as Error).message).replace(/\*\//g, "").slice(0, 120)} */`;
  }
});

app.get<{ Querystring: { q: string; near?: string } }>("/api/search", async (request, reply) => {
  const q = (request.query.q ?? "").trim();
  if (!q) return reply.code(400).send({ error: "q" });
  if (!search.ready) return reply.code(503).send({ error: "search has no key on this server" });
  try {
    return await search.find(q, lonLat(request.query.near) ?? undefined);
  } catch (refused) {
    if (refused instanceof ProviderError) return reply.code(502).send({ error: plain(refused.message) });
    throw refused;
  }
});

// Places of one kind around a point — the car apps' 주변 buttons. Fuel
// comes with the price of the asked-for fuel, chargers with free counts.
app.get<{ Querystring: { cat: string; at: string; r?: string; fuel?: string } }>("/api/nearby", async (request, reply) => {
  const category = request.query.cat as Category;
  if (!CATEGORIES.includes(category)) return reply.code(400).send({ error: `cat is one of ${CATEGORIES.join(",")}` });
  const at = lonLat(request.query.at);
  if (!at) return reply.code(400).send({ error: "at is lon,lat" });
  const fuel = (request.query.fuel ?? "B027") as Fuel;
  if (!(fuel in FUELS)) return reply.code(400).send({ error: `fuel is one of ${Object.keys(FUELS).join(",")}` });
  const radiusM = Math.min(20_000, Math.max(100, Number(request.query.r ?? 2000) || 2000));
  try {
    return await nearby.find({ category, at, radiusM, fuel });
  } catch (refused) {
    request.log.warn({ category }, (refused as Error).message);
    const status = refused instanceof NearbyError || refused instanceof ProviderError ? 502 : /no key/.test((refused as Error).message) ? 503 : 502;
    return reply.code(status).send({ error: plain((refused as Error).message) });
  }
});

// A finger on the map: the shops right there, and (for a long press) the
// address of the spot itself, so anywhere can be driven to.
app.get<{ Querystring: { at: string; r?: string; address?: string } }>("/api/here", async (request, reply) => {
  const at = lonLat(request.query.at);
  if (!at) return reply.code(400).send({ error: "at is lon,lat" });
  if (!nearby.kakao.ready) return reply.code(503).send({ error: "kakao has no key on this server" });
  const r = Math.min(200, Math.max(10, Number(request.query.r ?? 30) || 30));
  try {
    const [places, address] = await Promise.all([
      nearby.kakao.around(at, r),
      request.query.address ? nearby.kakao.address(at).catch(() => null) : Promise.resolve(null),
    ]);
    return { places, address };
  } catch (refused) {
    return reply.code(502).send({ error: plain((refused as Error).message) });
  }
});

// One station's every price, address and phone (the list call has only the one fuel).
app.get<{ Params: { id: string } }>("/api/nearby/gas/:id", async (request, reply) => {
  if (!nearby.opinet.ready) return reply.code(503).send({ error: "opinet has no key on this server" });
  try {
    return await nearby.opinet.detail(request.params.id);
  } catch (refused) {
    return reply.code(502).send({ error: (refused as Error).message });
  }
});

// NAVER's map for the page, in its GL (vector) mode: the same Client ID as
// Directions, with "Dynamic Map" ticked and this site's address listed as a
// Web 서비스 URL on the NCP console, else NAVER refuses it (401) and the page
// falls back. Written as a blocking script so NAVER's loader, which
// document.writes its GL module, runs in the page head.
app.get("/api/map/naver.js", async (_request, reply) => {
  reply.type("text/javascript; charset=utf-8").header("Cache-Control", "no-store");
  const id = settings.get("naverClientId");
  if (!id) return "/* no NAVER Client ID */";
  const src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(id)}&submodules=gl`;
  return `document.write(${JSON.stringify(`<script src="${src}"></scr` + `ipt>`)});`;
});

interface RouteQuery {
  provider: Provider | "all";
  start: string;
  goal: string;
}

app.get<{ Querystring: RouteQuery }>("/api/route", async (request, reply) => {
  const { provider: name, start, goal } = request.query;
  // Every keyed provider at once: the routes are not spliced (each one's
  // guides and traffic only make sense whole) but compared, by the client.
  if (name === "all") {
    const s = lonLat(start);
    const g = lonLat(goal);
    if (!s || !g) return reply.code(400).send({ error: "start and goal are lon,lat" });
    const keyed = Object.values(providers).filter((p) => p.ready && p.name !== "osrm");
    const ready = keyed.length ? keyed : [providers.osrm];
    if (ready.length === 0) return reply.code(503).send({ error: "no provider has a key on this server" });
    const settled = await Promise.allSettled(ready.map((p) => p.route({ start: s, goal: g })));
    const routes = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const errors = settled.flatMap((r, i) => (r.status === "rejected" ? [`${ready[i].name}: ${(r.reason as Error).message}`] : []));
    return { routes, errors };
  }
  const provider = providers[name];
  if (!provider) return reply.code(400).send({ error: `unknown provider ${name}` });
  if (!provider.ready) return reply.code(503).send({ error: `${name} has no key on this server` });
  const s = lonLat(start);
  const g = lonLat(goal);
  if (!s || !g) return reply.code(400).send({ error: "start and goal are lon,lat" });
  try {
    return await provider.route({ start: s, goal: g });
  } catch (refused) {
    if (refused instanceof ProviderError) {
      request.log.warn({ provider: refused.provider, status: refused.status }, refused.message);
      return reply.code(502).send({ error: refused.message });
    }
    throw refused;
  }
});

interface NearQuery {
  lon: string;
  lat: string;
  r?: string;
}

// Radius only. Which of these are *ahead*, on this road, in this direction,
// is the client's call: it holds the route polyline and the heading, and the
// public data carries no bearing to filter on here.
app.get<{ Querystring: NearQuery }>("/api/safety/near", async (request, reply) => {
  const lon = Number(request.query.lon);
  const lat = Number(request.query.lat);
  const r = Math.min(5000, Number(request.query.r ?? 1500));
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return reply.code(400).send({ error: "lon and lat" });
  // Accident hotspots join in when data.go.kr answers; a slow or refused
  // answer never holds up the cameras.
  const spots = hotspots.ready
    ? await Promise.race([hotspots.near([lon, lat], r).catch(() => []), new Promise<[]>((done) => setTimeout(() => done([]), 4000))])
    : [];
  return [...safety.near(lon, lat, r), ...spots].sort((a, b) => a.distanceM - b.distanceM);
});

// Words into sound, cached on disk under the phrase's hash.
const ttsDir = env.TTS_DIR ?? join(root, "tts");
const speaker = new Speaker(settings.reader("dashscopeApiKey"), ttsDir, settings.reader("ttsVoice"));
const madeVoices = new MadeVoices(settings.reader("dashscopeApiKey"));
/** A voice a page may ask for: one of Qwen's, or one the owner made. Anything else is the default. */
async function voiceAsked(asked: string | undefined): Promise<string> {
  if (!asked) return speaker.voice;
  if (SYSTEM_VOICES.some((v) => v.name === asked)) return asked;
  if (isMadeVoice(asked) && (await madeVoices.isMade(asked))) return asked;
  return speaker.voice;
}

// The voices the car page can choose from (안내 설정 → 목소리).
app.get("/api/tts/voices", async () => ({
  current: speaker.voice,
  system: SYSTEM_VOICES,
  mine: await madeVoices.list().catch(() => []),
}));

// A voice just chosen: its fixed sentences made in the background, one at a
// time and only the missing ones, so the drive after asks nothing new.
const warming = new Set<string>();
app.get<{ Querystring: { voice?: string } }>("/api/tts/warm", async (request, reply) => {
  if (!speaker.ready) return reply.code(503).send({ error: "tts has no key on this server" });
  const voice = await voiceAsked(request.query.voice);
  if (!warming.has(voice)) {
    warming.add(voice);
    prerender(speaker, voice)
      .then(({ made, had }) => app.log.info({ voice, made, had }, "voice warmed"))
      .catch((e) => app.log.warn({ voice, err: (e as Error).message }, "voice warm stopped"))
      .finally(() => warming.delete(voice));
  }
  return { voice, warming: true };
});

app.get<{ Querystring: { text: string; voice?: string } }>("/api/tts", async (request, reply) => {
  const text = (request.query.text ?? "").trim().slice(0, 200);
  if (!text) return reply.code(400).send({ error: "text" });
  try {
    const wav = await speaker.say(text, await voiceAsked(request.query.voice));
    return reply.header("Content-Type", "audio/wav").header("Cache-Control", "public, max-age=31536000, immutable").send(wav);
  } catch (refused) {
    request.log.warn({ text }, (refused as Error).message);
    return reply.code(speaker.ready ? 502 : 503).send({ error: (refused as Error).message });
  }
});

// A music stream with CORS on it, so the page's audio graph may carry it.
app.get<{ Querystring: { url: string } }>("/api/stream", async (request, reply) => {
  let url: URL;
  try {
    url = new URL(request.query.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    return reply.code(400).send({ error: "url" });
  }
  const upstream = await fetch(url, { headers: { "Icy-MetaData": "0", Range: request.headers.range ?? "" } });
  if (!upstream.ok || !upstream.body) return reply.code(502).send({ error: `${upstream.status}` });
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg");
  for (const h of ["content-length", "accept-ranges", "content-range"]) {
    const v = upstream.headers.get(h);
    if (v) reply.header(h, v);
  }
  return reply.code(upstream.status).send(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream));
});
// The settings page, and one real call per service to prove a key.
const admin = registerAdmin(app, settings, {
  status: () => ({
    tmap: providers.tmap.ready, kakao: providers.kakao.ready, naver: providers.naver.ready, osrm: "키 없음(무료)",
    검색: search.ready, 음성: speaker.ready, 목소리: speaker.voice,
    "음성 모델": speaker.ready ? (speaker.spent.current() ?? "무료 한도 모두 소진") + (speaker.spent.spentModels().length ? ` (소진: ${speaker.spent.spentModels().length}개)` : "") : false,
    "주유 가격": nearby.opinet.ready, 충전소: nearby.ev.ready ? true : nearby.kakao.ready ? "카카오 (빈 충전기 수 없음)" : false,
    시설물: safety.features.length,
    "단속 카메라": cameras ? `${cameras.features.length}대 (${new Date(cameras.at).toLocaleDateString("ko-KR")})` : camerasError ?? "아직 없음",
    "멘트 캐시": existsSync(ttsDir) ? readdirSync(ttsDir).filter((f) => f.endsWith(".wav")).length : 0,
  }),
  test: async () => {
    const start: LonLat = [127.0276, 37.4979], goal: LonLat = [127.0363, 37.5006];
    const word = async (ready: boolean, call: () => Promise<unknown>) => {
      if (!ready) return "키 없음";
      try { await call(); return "ok"; } catch (e) { return (e as Error).message.slice(0, 120); }
    };
    return {
      tmap: await word(providers.tmap.ready, () => providers.tmap.route({ start, goal })),
      kakao: await word(providers.kakao.ready, () => providers.kakao.route({ start, goal })),
      naver: await word(providers.naver.ready, () => providers.naver.route({ start, goal })),
      검색: await word(search.ready, () => search.find("서울역")),
      "주유 가격": await word(nearby.opinet.ready, () => nearby.opinet.near(start, 2000, "B027")),
      충전소: await word(nearby.ev.ready, () => nearby.ev.near(start, 1000)),
      음성: await word(speaker.ready, () => speaker.say("안내를 시작합니다")),
    };
  },
  prerender: () => prerender(speaker),
}, join(root, "admin", "index.html"));
registerMusic(app, settings, admin.guard);

const webDir = env.WEB_DIR ?? resolve(root, "..", "web", "dist");
if (existsSync(webDir)) {
  await app.register(fastifyStatic, { root: webDir, prefix: "/" });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "no such call" });
    return reply.sendFile("index.html");
  });
}

function lonLat(text: string | undefined): LonLat | null {
  const parts = (text ?? "").split(",").map(Number);
  if (parts.length !== 2 || !parts.every(Number.isFinite)) return null;
  return [parts[0], parts[1]];
}

const port = Number(env.PORT ?? 8080);
await app.listen({ port, host: "0.0.0.0" });

// Every fixed sentence rendered ahead of any drive, in the background and
// one at a time: only the ones missing are asked for, so after the first
// start this costs nothing. A key typed on /admin later is picked up by
// the page's own 고정 멘트 렌더링 button, or the next start.
// The cameras now, and again each hour: a week-old list is asked again,
// and a refusal (the 활용신청 not yet through) is retried soon after.
void refreshCameras();
setInterval(() => void refreshCameras(), 3_600_000);

if (speaker.ready) {
  prerender(speaker)
    .then(({ made, had }) => app.log.info({ made, had }, "fixed phrases ready"))
    .catch((e) => app.log.warn({ err: (e as Error).message }, "fixed phrases: stopped"));
}
