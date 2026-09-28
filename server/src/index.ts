import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Tmap } from "./route/tmap.js";
import { Kakao } from "./route/kakao.js";
import { Naver } from "./route/naver.js";
import { ProviderError, type LonLat, type Provider, type RouteProvider } from "./route/types.js";
import { SafetyIndex } from "./safety/index.js";
import { KakaoSearch } from "./search.js";
import { Speaker, prerender } from "./tts.js";
import { Readable } from "node:stream";
import { Settings } from "./settings.js";
import { registerAdmin } from "./admin.js";

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
};

const search = new KakaoSearch(settings.reader("kakaoRestKey"));

const dataDir = env.DATA_DIR ?? join(root, "data");
const safety = SafetyIndex.fromDirectory(dataDir);
app.log.info({ features: safety.features.length, dataDir }, "safety index built");

app.get("/api/health", async () => ({
  ok: true,
  providers: Object.fromEntries(Object.values(providers).map((p) => [p.name, p.ready])),
  safetyFeatures: safety.features.length,
  search: search.ready,
  tts: speaker.ready,
}));

app.get<{ Querystring: { q: string; near?: string } }>("/api/search", async (request, reply) => {
  const q = (request.query.q ?? "").trim();
  if (!q) return reply.code(400).send({ error: "q" });
  if (!search.ready) return reply.code(503).send({ error: "search has no key on this server" });
  try {
    return await search.find(q, lonLat(request.query.near) ?? undefined);
  } catch (refused) {
    if (refused instanceof ProviderError) return reply.code(502).send({ error: refused.message });
    throw refused;
  }
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
    const ready = Object.values(providers).filter((p) => p.ready);
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
  return safety.near(lon, lat, r);
});

// Words into sound, cached on disk under the phrase's hash.
const ttsDir = env.TTS_DIR ?? join(root, "tts");
const speaker = new Speaker(settings.reader("dashscopeApiKey"), ttsDir, settings.reader("ttsVoice"));
app.get<{ Querystring: { text: string } }>("/api/tts", async (request, reply) => {
  const text = (request.query.text ?? "").trim().slice(0, 200);
  if (!text) return reply.code(400).send({ error: "text" });
  try {
    const wav = await speaker.say(text);
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
registerAdmin(app, settings, {
  status: () => ({
    tmap: providers.tmap.ready, kakao: providers.kakao.ready, naver: providers.naver.ready,
    검색: search.ready, 음성: speaker.ready, 목소리: speaker.voice,
    시설물: safety.features.length,
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
      음성: await word(speaker.ready, () => speaker.say("안내를 시작합니다")),
    };
  },
  prerender: () => prerender(speaker),
}, join(root, "admin", "index.html"));

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
