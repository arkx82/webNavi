import maplibregl from "maplibre-gl";
import { api } from "./api";
import { Gps, type Fix } from "./gps";
import { chime, keepAwake } from "./probes";
import { Replay } from "./replay";
import { RouteLayer } from "./route-layer";
import { Tracker, type Shown } from "./tracker";
import { metres } from "./geo";
import { SpotifySource } from "./music/spotify";
import { StreamSource } from "./music/stream";
import { lazy, type MusicSource } from "./music/source";
import { Voice } from "./voice";
import { RouteWatch, phraseFor, type Feature } from "./warnings";
import type { Health, LonLat, Place, Provider, Route } from "./types";

// A key-free vector style; swap for a Mapbox/VWorld style URL through
// VITE_MAP_STYLE once Korean coverage has been compared in the car.
const style = import.meta.env.VITE_MAP_STYLE ?? "https://tiles.openfreemap.org/styles/liberty";
const HOME: LonLat = [127.0276, 37.4979];
const NAMES: Record<Provider, string> = { tmap: "티맵", kakao: "카카오", naver: "네이버" };
/** How often the road is asked again for a better way, and how much better it must be. */
const RECHECK_MS = 6 * 60_000;
const BETTER_BY_S = 3 * 60;

const map = openMap();

/**
 * The map, or a plain word about why not: without WebGL MapLibre throws
 * while being built, and a page that dies on its first line tells the
 * driver nothing.
 */
function openMap(): maplibregl.Map {
  try {
    return new maplibregl.Map({ container: "map", style, center: HOME, zoom: 15, pitch: 45, attributionControl: false });
  } catch (e) {
    const box = document.getElementById("map")!;
    box.textContent = `지도를 그릴 수 없습니다 (WebGL): ${(e as Error).message}`;
    box.style.cssText = "display:flex;align-items:center;justify-content:center;padding:24px 24px 24px 360px;color:#9a9a9a;font-size:18px;text-align:center";
    throw e;
  }
}

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const lines: string[] = [];
function log(text: string) {
  lines.push(`${new Date().toLocaleTimeString("ko-KR", { hour12: false })} ${text}`);
  if (lines.length > 200) lines.shift();
  el("log").textContent = lines.join("\n");
  el("log").scrollTop = el("log").scrollHeight;
}

// ---- the car ---------------------------------------------------------------

const dot = document.createElement("div");
dot.style.cssText = "width:18px;height:18px;border-radius:50%;background:#4fc3f7;border:3px solid #fff;box-shadow:0 0 8px #000";
const marker = new maplibregl.Marker({ element: dot }).setLngLat(HOME);

let follow = true;
let placed = false;
const gps = new Gps();
const tracker = new Tracker();
const voice = new Voice();
voice.onError = (m) => {
  el("voice").textContent = "실패";
  log(`음성 실패 ${m}`);
};
const stream = new StreamSource(voice);
gps.onError = (m) => log(`GPS 오류 ${m}`);
gps.on(onFix);

function onFix(fix: Fix) {
  tracker.feed(fix);
  void watchRoad(fix);
  el("speed").textContent = fix.speed == null ? "--" : Math.round(fix.speed * 3.6).toString();
  el("pos").textContent = `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}`;
  el("acc").textContent = `${Math.round(fix.accM)} m`;
  el("heading").textContent = `${fix.heading == null ? "없음" : Math.round(fix.heading) + "°"} / 계산 ${fix.course == null ? "--" : Math.round(fix.course) + "°"}`;
  const period = gps.period();
  el("period").textContent = period == null ? "--" : `${period.toFixed(1)} s`;
  el("count").textContent = gps.samples.length.toString();
  if (!placed) {
    marker.addTo(map);
    placed = true;
    log(`첫 수신: speed=${fix.speed} heading=${fix.heading} acc=${fix.accM}`);
  }
}

// Sixty times a second: the tracker says where the car is drawn, whether
// a fix came or not; the camera turns toward the road a little each frame.
const MODES = { waiting: "대기", gps: "GPS", reckoning: "추측 항법", snapping: "복귀 중" };
function frame() {
  const shown = tracker.frame();
  if (shown) {
    marker.setLngLat(shown.at);
    el("mode").textContent = MODES[shown.mode] + (shown.offM != null ? ` · ${Math.round(shown.offM)} m` : "");
    if (follow) {
      map.jumpTo({ center: shown.at, bearing: tracker.cameraBearing(map.getBearing()) });
    }
    showTurn(shown);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function setFollow(on: boolean) {
  follow = on;
  el("follow").classList.toggle("on", on);
  if (on && gps.last) map.easeTo({ center: [gps.last.lon, gps.last.lat], pitch: 45, zoom: Math.max(map.getZoom(), 15) });
}
el("follow").addEventListener("click", () => setFollow(!follow));
map.on("dragstart", () => setFollow(false));

/** Where a route starts: the car, or the map's middle before the first fix. */
function here(): LonLat {
  const last = gps.last;
  if (last) return [last.lon, last.lat];
  const c = map.getCenter();
  return [c.lng, c.lat];
}

// ---- the trip --------------------------------------------------------------

let health: Health | null = null;
let goal: Place | null = null;
/** Every provider's answer for this goal, and the one being driven. */
let offers: Route[] = [];
let route: Route | null = null;
/** Set when the driver tapped a provider; else the fastest is driven. */
let preferred: Provider | null = null;
let recheck: number | null = null;
let rerouting = false;
const routeLayer = new RouteLayer(map);

async function search(q: string) {
  const results = el<HTMLUListElement>("results");
  results.replaceChildren();
  results.hidden = false;
  try {
    const places = await api.search(q, gps.last ? here() : undefined);
    if (places.length === 0) results.append(item("결과 없음", ""));
    for (const p of places) {
      const li = item(p.name, `${p.address}${p.distanceM != null ? ` · ${km(p.distanceM)}` : ""}`);
      li.addEventListener("click", () => {
        results.hidden = true;
        void go(p);
      });
      results.append(li);
    }
  } catch (e) {
    results.append(item("검색 실패", (e as Error).message));
  }
}

function item(title: string, sub: string) {
  const li = document.createElement("li");
  li.textContent = title;
  const small = document.createElement("small");
  small.textContent = sub;
  li.append(small);
  return li;
}

/** Ask every provider; drive the preferred one, else the quickest. */
async function go(place: Place, quietly = false) {
  goal = place;
  el("trip").hidden = false;
  el("trip-name").textContent = place.name;
  if (!quietly) el("trip-sum").textContent = "경로 찾는 중…";
  try {
    const answer = await api.routes(here(), place.at);
    for (const e of answer.errors) log(`경로 실패 ${e}`);
    if (answer.routes.length === 0) throw new Error(answer.errors.join("; ") || "경로 없음");
    offers = answer.routes.sort((a, b) => a.durationS - b.durationS);
    const chosen = offers.find((r) => r.provider === preferred) ?? offers[0];
    drive(chosen, !quietly);
    log(`경로 ${offers.map((r) => `${r.provider} ${minutes(r.durationS)}`).join(", ")} → ${chosen.provider}`);
  } catch (e) {
    if (!quietly) {
      route = null;
      routeLayer.show(null);
      el("trip-sum").textContent = `경로 실패: ${(e as Error).message}`;
    }
  }
  drawProviders();
  if (recheck == null) recheck = window.setInterval(() => void recheckRoute(), RECHECK_MS);
}

function drive(chosen: Route, fitView: boolean) {
  route = chosen;
  routeLayer.show(route);
  tracker.setRoute(route);
  watch = new RouteWatch(route);
  watchedAt = null;
  turnsSaid.clear();
  arrived = false;
  el("trip-sum").textContent = `${km(route.distanceM)} · ${minutes(route.durationS)} · ${NAMES[route.provider]}`;
  if (fitView) {
    setFollow(false);
    routeLayer.fit(route);
  }
}

/** Every few minutes on the way: a much quicker route from any provider wins. */
async function recheckRoute() {
  if (!goal || !route || !gps.last || rerouting) return;
  const current = tracker.frame()?.remainingS ?? route.durationS;
  try {
    const answer = await api.routes(here(), goal.at);
    const best = answer.routes.sort((a, b) => a.durationS - b.durationS)[0];
    if (best && best.durationS < current - BETTER_BY_S) {
      offers = answer.routes;
      log(`더 빠른 길: ${best.provider} ${minutes(best.durationS)} (지금 ${minutes(current)})`);
      voice.say("더 빠른 길로 안내합니다");
      drive(best, false);
      drawProviders();
    }
  } catch (e) {
    log(`재확인 실패 ${(e as Error).message}`);
  }
}

// Off the road for three seconds: the route is asked again from here.
tracker.onOffRoute = async () => {
  if (!goal || rerouting) return;
  rerouting = true;
  log("경로 이탈 — 재탐색");
  voice.say("경로를 벗어나 다시 찾습니다");
  el("trip-sum").textContent = "경로 이탈 · 재탐색 중…";
  try {
    await go(goal, true);
  } finally {
    rerouting = false;
  }
};

function drawProviders() {
  const row = el("providers");
  row.replaceChildren();
  for (const name of ["tmap", "kakao", "naver"] as Provider[]) {
    if (health && !health.providers[name]) continue;
    const offer = offers.find((r) => r.provider === name);
    const b = document.createElement("button");
    b.textContent = NAMES[name];
    const small = document.createElement("small");
    small.textContent = offer ? minutes(offer.durationS) : "–";
    b.append(small);
    b.classList.toggle("on", name === route?.provider);
    b.disabled = !offer;
    b.addEventListener("click", () => {
      preferred = name;
      if (offer) {
        drive(offer, true);
        drawProviders();
      }
    });
    row.append(b);
  }
}

/** Distances at which a turn is spoken; each once per guide. */
const TURN_RUNGS_M = [500, 150];
const turnsSaid = new Map<string, Set<number>>();
let arrived = false;

function showTurn(shown: Shown) {
  const turn = el("turn");
  if (!route || !shown.nextGuide) {
    turn.hidden = true;
    if (route && shown.remainingM != null && shown.remainingM < 30 && !arrived) {
      arrived = true;
      voice.say("목적지에 도착했습니다");
    }
    return;
  }
  turn.hidden = false;
  el("turn-in").textContent = km(shown.nextGuide.inM);
  el("turn-text").textContent = shown.nextGuide.guide.text;
  const key = `${shown.nextGuide.guide.at[0]},${shown.nextGuide.guide.at[1]}`;
  const said = turnsSaid.get(key) ?? new Set<number>();
  for (const rung of TURN_RUNGS_M) {
    if (said.has(rung) || shown.nextGuide.inM > rung) continue;
    said.add(rung);
    turnsSaid.set(key, said);
    voice.say(`${rung}미터 앞 ${shown.nextGuide.guide.text}`);
    break;
  }
  if (shown.remainingM != null && shown.remainingS != null) {
    el("trip-sum").textContent = `남은 ${km(shown.remainingM)} · ${minutes(shown.remainingS)} · ${NAMES[route.provider]}`;
  }
}

el("clear").addEventListener("click", () => {
  goal = null;
  route = null;
  offers = [];
  preferred = null;
  routeLayer.show(null);
  tracker.setRoute(null);
  watch = null;
  el("trip").hidden = true;
  if (recheck != null) clearInterval(recheck);
  recheck = null;
  setFollow(true);
});

el<HTMLFormElement>("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = el<HTMLInputElement>("q");
  const q = input.value.trim();
  input.blur();
  if (!q) return;
  // A bare "lon,lat" routes without a search key, for the desk.
  const m = q.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    el("results").hidden = true;
    void go({ name: q, address: "", at: [Number(m[1]), Number(m[2])] });
  } else {
    void search(q);
  }
});

const km = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const minutes = (s: number) => (s < 3600 ? `${Math.round(s / 60)}분` : `${Math.floor(s / 3600)}시간 ${Math.round((s % 3600) / 60)}분`);

// ---- the road ahead --------------------------------------------------------

let watch: RouteWatch | null = null;
/** Where the server was last asked what is near; asked again 500 m on or after 30 s. */
let watchedAt: { at: LonLat; t: number } | null = null;

async function watchRoad(fix: Fix) {
  if (!watch || !route) return;
  const moved = watchedAt ? metres(watchedAt.at[0], watchedAt.at[1], fix.lon, fix.lat) : Infinity;
  if (moved > 500 || !watchedAt || Date.now() - watchedAt.t > 30_000) {
    watchedAt = { at: [fix.lon, fix.lat], t: Date.now() };
    try {
      const near = await (await fetch(`/api/safety/near?lon=${fix.lon}&lat=${fix.lat}&r=1500`)).json() as Feature[];
      watch.add(near);
    } catch (e) {
      log(`시설물 조회 실패 ${(e as Error).message}`);
    }
  }
  const along = tracker.frame()?.alongM;
  if (along == null) return;
  for (const due of watch.due(along)) {
    const phrase = phraseFor(due);
    log(`경고 ${phrase}`);
    voice.say(phrase);
  }
}

// ---- music -----------------------------------------------------------------

const sources: MusicSource[] = [
  stream,
  new SpotifySource(),
  lazy("tidal", "TIDAL", async () => new (await import("./music/tidal")).TidalSource()),
];
let music: MusicSource | null = null;

function musicSay(text: string, bad = false) {
  el("music-msg").textContent = text;
  el("music-msg").style.color = bad ? "#ff4d4f" : "";
}

async function drawSources() {
  const row = el("music-sources");
  row.replaceChildren();
  let state: Record<string, { connected: boolean }> = {};
  try { state = await (await fetch("/api/music/state")).json(); } catch { /* server away */ }
  for (const s of sources) {
    if (s.id !== "stream" && !state[s.id]?.connected) continue;
    const b = document.createElement("button");
    b.textContent = s.label;
    b.classList.toggle("on", s === music);
    b.addEventListener("click", () => void pickSource(s));
    row.append(b);
  }
}

async function pickSource(s: MusicSource) {
  if (music && music !== s) {
    music.disconnect();
    voice.duckers.delete(duckBySource);
  }
  music = s;
  el("music-form").hidden = s.id !== "stream";
  el("music-controls").hidden = true;
  el("music-lists").hidden = true;
  el("now").hidden = true;
  musicSay(s.id === "stream" ? "" : `${s.label} 연결 중…`);
  await drawSources();
  try {
    await s.connect();
    s.onState((now) => {
      el("now").hidden = !now.title;
      el("now-title").textContent = now.title ?? "";
      el("now-artist").textContent = now.artist ?? "";
      const art = el<HTMLImageElement>("now-art");
      if (now.art) art.src = now.art; else art.removeAttribute("src");
      el("music-toggle").textContent = now.playing ? "⏸" : "▶";
    });
    voice.duckers.add(duckBySource);
    el("music-controls").hidden = false;
    musicSay("");
    await showLists();
  } catch (e) {
    musicSay(`${s.label}: ${(e as Error).message}`, true);
    log(`음악 ${s.label} 실패 ${(e as Error).message}`);
  }
}

function duckBySource(level: number) {
  music?.setVolume(level);
}

async function showLists() {
  if (!music) return;
  const ul = el<HTMLUListElement>("music-lists");
  ul.replaceChildren();
  try {
    const lists = await music.playlists();
    for (const p of lists) {
      const li = item(p.name, p.count != null ? `${p.count}곡` : "");
      li.addEventListener("click", async () => {
        ul.hidden = true;
        try { await music!.play(p.uri); } catch (e) { musicSay((e as Error).message, true); }
      });
      ul.append(li);
    }
    ul.hidden = lists.length === 0;
  } catch (e) {
    musicSay((e as Error).message, true);
  }
}

el("music-lists-toggle").addEventListener("click", () => {
  const ul = el("music-lists");
  if (ul.hidden) void showLists(); else ul.hidden = true;
});
el("music-toggle").addEventListener("click", () => void music?.toggle().catch((e) => musicSay(e.message, true)));
el("music-next").addEventListener("click", () => void music?.next().catch((e) => musicSay(e.message, true)));
el("music-prev").addEventListener("click", () => void music?.previous().catch((e) => musicSay(e.message, true)));
el<HTMLFormElement>("music-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = el<HTMLInputElement>("music-url").value.trim();
  if (!url) return;
  try {
    await stream.play(url);
    el("music-controls").hidden = false;
  } catch (err) {
    musicSay(`재생 실패: ${(err as Error).message}`, true);
  }
});
void drawSources();

// ---- probes and replay -----------------------------------------------------

el("beep").addEventListener("click", async () => {
  await voice.unlock();
  el("voice").textContent = voice.context.state;
  const said = await chime();
  el("audio").textContent = said;
  log(`오디오 ${said}`);
});
el("save").addEventListener("click", () => {
  const blob = new Blob([gps.asCsv()], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `gps-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  a.click();
});
let replay: Replay | null = null;
el<HTMLInputElement>("replay").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  replay?.stop();
  const fixes = Replay.fromCsv(await file.text());
  const speedup = Number(new URLSearchParams(location.search).get("speedup") ?? 4);
  replay = new Replay(gps, fixes, speedup);
  log(`재생 ${file.name}: ${fixes.length}점, ${speedup}배속`);
  replay.start();
});

// Audio only starts after a tap; the first one anywhere on the page does it.
document.addEventListener("pointerdown", () => void voice.unlock().then(() => { el("voice").textContent = voice.context.state; }), { once: true });

map.on("load", async () => {
  log(`UA ${navigator.userAgent}`);
  log(`secure=${window.isSecureContext} style=${style}`);
  el("wake").textContent = await keepAwake();
  gps.start();
  try {
    health = await api.health();
    log(`서버 ${JSON.stringify(health)}`);
    if (!health.search) el<HTMLInputElement>("q").placeholder = "검색 키 없음 — lon,lat 입력";
  } catch {
    log("서버 응답 없음 (/api/health)");
  }
});
