import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Tmap } from "./route/tmap.js";
import { Kakao } from "./route/kakao.js";
import { Naver } from "./route/naver.js";
import { ProviderError, type LonLat, type Provider, type RouteProvider } from "./route/types.js";
import { SafetyIndex } from "./safety/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const env = process.env;

const app = Fastify({ logger: { level: env.LOG_LEVEL ?? "info" } });

// The keys live here and nowhere else: the car's browser only ever sees
// this server. A provider without a key is simply not offered.
const providers: Record<Provider, RouteProvider> = {
  tmap: new Tmap(env.TMAP_APP_KEY),
  kakao: new Kakao(env.KAKAO_REST_KEY),
  naver: new Naver(env.NAVER_CLIENT_ID, env.NAVER_CLIENT_SECRET),
};

const dataDir = env.DATA_DIR ?? join(root, "data");
const safety = SafetyIndex.fromDirectory(dataDir);
app.log.info({ features: safety.features.length, dataDir }, "safety index built");

app.get("/api/health", async () => ({
  ok: true,
  providers: Object.fromEntries(Object.values(providers).map((p) => [p.name, p.ready])),
  safetyFeatures: safety.features.length,
  tts: !!env.DASHSCOPE_API_KEY,
}));

interface RouteQuery {
  provider: Provider;
  start: string;
  goal: string;
}

app.get<{ Querystring: RouteQuery }>("/api/route", async (request, reply) => {
  const { provider: name, start, goal } = request.query;
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

// Pre-rendered phrases, and later the built web app, as plain files.
const ttsDir = env.TTS_DIR ?? join(root, "tts");
if (existsSync(ttsDir)) {
  await app.register(fastifyStatic, { root: ttsDir, prefix: "/tts/", decorateReply: false });
}
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
