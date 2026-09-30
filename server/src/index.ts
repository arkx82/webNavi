import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Tmap } from "./route/tmap.js";
import { Kakao } from "./route/kakao.js";
import { Naver } from "./route/naver.js";
import { Osrm } from "./route/osrm.js";
import { ProviderError, type LonLat, type Provider, type RouteProvider } from "./route/types.js";
import { SafetyIndex } from "./safety/index.js";
import { CAMERAS_MAX_AGE_MS, fetchCameras, keptCameras } from "./safety/cameras.js";
import { Hotspots } from "./safety/hotspots.js";
import { BUMPS, DATASET_MAX_AGE_MS, LIGHTS, SCHOOL_ZONES, SENIOR_ZONES, SEOUL_LIGHTS, kept, refresh, type Dataset, type KeptSet } from "./safety/datasets.js";
import { Incidents } from "./road/incidents.js";
import { RestAreas } from "./road/rest-areas.js";
import { ColourGuides } from "./road/color-guides.js";
import { AirKorea } from "./air.js";
import { KmaAlerts } from "./alerts.js";
import { KakaoSearch } from "./search.js";
import { CATEGORIES, FUELS, Nearby, type Category, type Fuel } from "./nearby/index.js";
import { NearbyError } from "./nearby/util.js";
import { Speaker, isMadeVoice, prerender, repairClipped } from "./tts.js";
import { fixedPhrases } from "./phrases.js";
import { CLONED_MODEL, MadeVoices, SYSTEM_VOICES } from "./voices.js";
import { KmaWeather } from "./weather.js";
import { Readable } from "node:stream";
import { Settings } from "./settings.js";
import { registerAdmin } from "./admin.js";
import { registerMusic } from "./music.js";
import { Db } from "./db.js";
import { registerUsers } from "./users.js";
import { RefusedUrl, fetchPublic, registerGuard } from "./guard.js";
import { registerHdmap } from "./hdmap.js";
import { Traffic } from "./road/traffic.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const env = process.env;

const app = Fastify({ logger: { level: env.LOG_LEVEL ?? "info" } });

// The keys live here and nowhere else: the car's browser only ever sees
// this server. They are read at every call, so a key typed on /admin is
// in force at once; a provider without one is simply not offered.
const settings = new Settings(env.CONFIG_DIR ?? join(root, "config"));
// Users, what each keeps, and the voice's index: one SQLite file beside the settings.
const db = new Db(env.CONFIG_DIR ?? join(root, "config"));
const workDir = env.WORK_DIR ?? join(root, "work");
// ITS 소통정보 into our own router's speeds, while it is in use (road/traffic.ts).
const traffic = new Traffic(settings.reader("itsKey"), join(workDir, "nodelink"), (m) => app.log.info(m));
const providers: Record<Provider, RouteProvider> = {
  tmap: new Tmap(settings.reader("tmapAppKey")),
  kakao: new Kakao(settings.reader("kakaoRestKey")),
  naver: new Naver(settings.reader("naverClientId"), settings.reader("naverClientSecret")),
  // OpenStreetMap roads with no key and no traffic: the desk's provider,
  // and the road under the demo. Left out of "all" when a real one answers.
  osrm: new Osrm(),
  // The same engine over 표준노드링크 on this host (tools/nodelink/build.py; compose's osrm service).
  // Offered only once ITS answers this key with live speeds (the owner's call: a route without traffic is not worth a card).
  korea: new Osrm(env.KOREA_OSRM_URL ?? "http://osrm:5000", "korea", () => !!env.KOREA_OSRM_URL && traffic.live, traffic.links),
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
// Speed bumps and school zones, the same way: the whole country, kept a week.
const DATASETS: Dataset[] = [BUMPS, SCHOOL_ZONES, LIGHTS, SEOUL_LIGHTS, SENIOR_ZONES];
const sets = new Map<Dataset["name"], KeptSet>();
const setErrors = new Map<Dataset["name"], string>();
for (const d of DATASETS) {
  const k = kept(configDir, d.name);
  if (k) sets.set(d.name, k);
}
let safety = buildSafety();
function buildSafety(): SafetyIndex {
  const index = SafetyIndex.fromDirectory(dataDir);
  if (cameras) index.add(cameras.features);
  for (const k of sets.values()) index.add(k.features);
  return index.build();
}
app.log.info({ features: safety.features.length, cameras: cameras?.features.length ?? 0, bumps: sets.get("bumps")?.features.length ?? 0, schoolZones: sets.get("school-zones")?.features.length ?? 0, dataDir }, "safety index built");
const hotspots = new Hotspots(settings.reader("dataGoKrKey"), (at) => nearby.ev.districtOf(at));
let camerasError: string | null = null;
/** One list at a time: the speed bumps alone are fourteen hundred pages. */
let refreshingSets = false;
async function refreshSets() {
  if (refreshingSets) return;
  refreshingSets = true;
  // The index is built once at the end, whatever number of lists came in, not once per list.
  let changed = false;
  try {
    for (const d of DATASETS) {
      const key = settings.get(d.keyName ?? "dataGoKrKey");
      if (!key) continue;
      const have = sets.get(d.name);
      app.log.debug({ set: d.name, have: have?.features.length ?? 0, ageH: have ? Math.round((Date.now() - have.at) / 3_600_000) : null }, "dataset check");
      if (have && Date.now() - have.at < DATASET_MAX_AGE_MS) continue;
      try {
        const got = await refresh(d, key, configDir);
        sets.set(d.name, got);
        setErrors.delete(d.name);
        changed = true;
        app.log.info({ set: d.name, features: got.features.length }, "dataset fetched");
      } catch (e) {
        setErrors.set(d.name, (e as Error).message);
        app.log.warn({ set: d.name, err: (e as Error).message }, "dataset: not fetched");
      }
    }
    if (changed) safety = buildSafety();
  } finally {
    refreshingSets = false;
  }
}
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
  road: { incidents: incidents.ready, restAreas: restAreas.ready, alerts: alerts.ready, traffic: traffic.ready },
  hdmap: hdTiles.ready,
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

// The weather where the car is (기상청 단기·중기예보, the data.go.kr key),
// with 에어코리아's 미세먼지 beside it when the region can be named.
const weather = new KmaWeather(settings.reader("dataGoKrKey"));
const regionOf = (at: LonLat) => (nearby.kakao.ready ? nearby.kakao.regionNames(at) : Promise.resolve(null));
const air = new AirKorea(settings.reader("dataGoKrKey"), regionOf);
const alerts = new KmaAlerts(settings.reader("dataGoKrKey"), regionOf);
app.get<{ Querystring: { at: string } }>("/api/weather", async (request, reply) => {
  const at = lonLat(request.query.at);
  if (!at) return reply.code(400).send({ error: "at is lon,lat" });
  if (!weather.ready) return reply.code(503).send({ error: "weather has no data.go.kr key on this server" });
  try {
    const [w, a] = await Promise.all([
      weather.at(at),
      air.at(at).catch((e) => { request.log.warn({ err: (e as Error).message }, "air"); return null; }),
    ]);
    return { ...w, air: a };
  } catch (refused) {
    return reply.code(502).send({ error: (refused as Error).message });
  }
});

// 기상특보 in force where the car is.
app.get<{ Querystring: { at: string } }>("/api/alerts", async (request, reply) => {
  const at = lonLat(request.query.at);
  if (!at) return reply.code(400).send({ error: "at is lon,lat" });
  if (!alerts.ready) return reply.code(503).send({ error: "alerts have no data.go.kr key on this server" });
  try {
    return await alerts.at(at);
  } catch (refused) {
    return reply.code(502).send({ error: (refused as Error).message });
  }
});

// ITS 돌발상황 round the car, kilometres out: the page places them on its route.
const incidents = new Incidents(settings.reader("itsKey"));
app.get<{ Querystring: { at: string; r?: string } }>("/api/road/incidents", async (request, reply) => {
  const at = lonLat(request.query.at);
  if (!at) return reply.code(400).send({ error: "at is lon,lat" });
  if (!incidents.ready) return reply.code(503).send({ error: "incidents have no ITS key on this server" });
  const r = Math.min(50_000, Math.max(500, Number(request.query.r ?? 15_000) || 15_000));
  // A car on the move asks this every few minutes: the router's speeds round it are kept fresh meanwhile.
  traffic.touch([at]);
  try {
    return await incidents.near(at, r);
  } catch (refused) {
    return reply.code(502).send({ error: (refused as Error).message });
  }
});

// 노면색깔유도선 at a motorway junction: which colour of line leads to each branch.
const colourGuides = new ColourGuides(configDir, (town) => (search.ready ? search.find(town).then((p) => p[0]?.at ?? null) : Promise.resolve(null)));
const refreshGuides = () => void colourGuides.refresh().catch((e) => app.log.warn({ err: (e as Error).message }, "color guides"));
refreshGuides();
setInterval(refreshGuides, 86_400_000);
app.get<{ Querystring: { name?: string; at?: string; in?: string; roads?: string } }>("/api/road/color-guide", async (request, reply) => {
  const at = lonLat(request.query.at);
  const inDeg = Number(request.query.in);
  if (!request.query.name || !at || !Number.isFinite(inDeg)) return reply.code(400).send({ error: "name, at, in" });
  const roads = (request.query.roads ?? "").split(",").map((r) => r.trim()).filter(Boolean).slice(0, 4);
  return (await colourGuides.at(request.query.name, at, inDeg, roads)) ?? {};
});

// Every motorway rest area with its prices now; two hundred, so all at once.
const restAreas = new RestAreas(settings.reader("exKey"));
app.get("/api/road/rest-areas", async (request, reply) => {
  if (!restAreas.ready) return reply.code(503).send({ error: "rest areas have no 한국도로공사 key on this server" });
  try {
    return await restAreas.all();
  } catch (refused) {
    request.log.warn({ err: (refused as Error).message }, "rest areas");
    return reply.code(502).send({ error: (refused as Error).message });
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
  /** The car's heading and speed at the start, when moving. */
  heading?: string;
  speed?: string;
}

/** The heading asked with a route, if a sensible one was given. */
function headingOf(q: RouteQuery): { heading?: number; speedKmh?: number } {
  const h = Number(q.heading), v = Number(q.speed);
  return q.heading != null && Number.isFinite(h) ? { heading: ((h % 360) + 360) % 360, speedKmh: Number.isFinite(v) ? v : undefined } : {};
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
    const settled = await Promise.allSettled(ready.map((p) => p.route({ start: s, goal: g, ...headingOf(request.query) })));
    const routes = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const errors = settled.flatMap((r, i) => (r.status === "rejected" ? [`${ready[i].name}: ${(r.reason as Error).message}`] : []));
    traffic.touch([s, g, ...routes.flatMap((r) => r.path.filter((_, i) => i % 20 === 0))]);
    return { routes, errors };
  }
  const provider = providers[name];
  if (!provider) return reply.code(400).send({ error: `unknown provider ${name}` });
  if (!provider.ready) return reply.code(503).send({ error: `${name} has no key on this server` });
  const s = lonLat(start);
  const g = lonLat(goal);
  if (!s || !g) return reply.code(400).send({ error: "start and goal are lon,lat" });
  try {
    const route = await provider.route({ start: s, goal: g, ...headingOf(request.query) });
    traffic.touch([s, g, ...route.path.filter((_, i) => i % 20 === 0)]);
    return route;
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
speaker.ledger = {
  made: (file, voice, text, model, bytes) => db.ttsMade(basename(file), voice, text, model, bytes),
  // A file from before the index began is entered the first time it is served.
  used: (file, voice, text, bytes) => (db.ttsKnown(basename(file)) ? db.ttsUsed(basename(file)) : db.ttsMade(basename(file), voice, text, null, bytes)),
  repaired: (file) => db.ttsRepaired(basename(file)),
};
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
  // The cloning model's free allowance gone: a made voice speaks in the default one until it comes back.
  mineSpent: speaker.spent.isSpent(CLONED_MODEL),
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
  // Only to public hosts: a user-given address must not reach into the house (guard.ts).
  let upstream: Response;
  try {
    upstream = await fetchPublic(url, { headers: { "Icy-MetaData": "0", Range: request.headers.range ?? "" } });
  } catch (e) {
    if (e instanceof RefusedUrl) return reply.code(403).send({ error: e.message });
    return reply.code(502).send({ error: (e as Error).message });
  }
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
    tmap: providers.tmap.ready, kakao: providers.kakao.ready, naver: providers.naver.ready, osrm: "키 없음(무료)", 자체경로: !env.KOREA_OSRM_URL ? "KOREA_OSRM_URL 없음" : providers.korea.ready ? `켜짐 (OSRM ${env.KOREA_OSRM_URL}, ITS 소통정보 수신 중)` : traffic.status().approved === false ? "꺼짐 — ITS 키 승인 대기 (승인되면 자동으로 켜짐)" : "꺼짐 — ITS 소통정보가 아직 한 번도 오지 않음",
    검색: search.ready, 음성: speaker.ready, 목소리: speaker.voice,
    "음성 모델": speaker.ready ? (speaker.spent.current() ?? "무료 한도 모두 소진") + (speaker.spent.spentModels().length ? ` (소진: ${speaker.spent.spentModels().length}개)` : "") : false,
    "주유 가격": nearby.opinet.ready, 충전소: nearby.ev.ready ? true : nearby.kakao.ready ? "카카오 (빈 충전기 수 없음)" : false,
    시설물: safety.features.length,
    "단속 카메라": cameras ? `${cameras.features.length}대 (${new Date(cameras.at).toLocaleDateString("ko-KR")})` : camerasError ?? "아직 없음",
    ...Object.fromEntries(DATASETS.map((d) => {
      const k = sets.get(d.name);
      return [d.label, k ? `${k.features.length}곳 (${new Date(k.at).toLocaleDateString("ko-KR")})` : setErrors.get(d.name) ?? (refreshingSets ? "받는 중…" : "아직 없음")];
    })),
    돌발상황: incidents.ready, 휴게소: restAreas.ready,
    소통정보: (() => { const t = traffic.status(); return !traffic.ready ? (traffic.links.ready ? "ITS 키 없음" : "links.db 없음") : `${t.active ? "갱신 중" : "쉬는 중"} · 상자 ${t.cells} · 링크 ${t.links} · 오늘 ${t.callsToday}건${t.lastError ? ` · 오류 ${t.lastError}` : ""}`; })(),
    "멘트 캐시": existsSync(ttsDir) ? readdirSync(ttsDir).filter((f) => f.endsWith(".wav")).length : 0,
    "멘트 기록": (() => { const t = db.ttsStats(); return `${t.sentences}문장 · 재사용 ${Math.max(0, t.uses - t.sentences)}회 · ${(t.bytes / 1e6).toFixed(1)} MB`; })(),
    사용자: db.users().length,
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
      자체경로: await word(providers.korea.ready, () => providers.korea.route({ start, goal })),
      검색: await word(search.ready, () => search.find("서울역")),
      "주유 가격": await word(nearby.opinet.ready, () => nearby.opinet.near(start, 2000, "B027")),
      충전소: await word(nearby.ev.ready, () => nearby.ev.near(start, 1000)),
      음성: await word(speaker.ready, () => speaker.say("안내를 시작합니다")),
      돌발상황: await word(incidents.ready, () => incidents.everything()),
      휴게소: await word(restAreas.ready, () => restAreas.all()),
      미세먼지: await word(air.ready && nearby.kakao.ready, async () => { if (!(await air.at(start))) throw new Error("측정값 없음"); }),
      기상특보: await word(alerts.ready, () => alerts.now()),
    };
  },
  prerender: () => prerender(speaker),
}, join(root, "admin", "index.html"));
registerMusic(app, settings, admin.guard);
registerUsers(app, db, settings, admin.adminGuard, workDir);
registerGuard(app);
// 정밀도로지도 tiles, built into WORK_DIR by tools/hdmap/build.py.
const hdTiles = registerHdmap(app, workDir);

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
void refreshCameras().then(() => refreshSets());
setInterval(() => void refreshCameras().then(() => refreshSets()), 3_600_000);

// Then the kept sentences that end cut off: taken out, and the ones still said made again.
async function repairVoice() {
  const fixed = new Set(fixedPhrases());
  const weekAgo = Date.now() - 7 * 86_400_000;
  const r = await repairClipped(speaker, ttsDir, (f) => db.ttsRow(f), (text) => fixed.has(text) || db.ttsUsedSince(text, weekAgo), (f) => db.ttsForget(f));
  app.log.info(r, "clipped sentences repaired");
}
if (speaker.ready) {
  prerender(speaker)
    .then(({ made, had }) => app.log.info({ made, had }, "fixed phrases ready"))
    .then(() => repairVoice())
    .catch((e) => app.log.warn({ err: (e as Error).message }, "fixed phrases: stopped"));
}
