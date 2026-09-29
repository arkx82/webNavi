import maplibregl from "maplibre-gl";
import { api } from "./api";
import { Gps, type Fix } from "./gps";
import { chime, keepAwake } from "./probes";
import { Replay } from "./replay";
import { Simulator } from "./simulate";
import { RouteLayer } from "./route-layer";
import { Tracker, type Shown } from "./tracker";
import { Line, metres } from "./geo";
import { arrowSvg, maneuverOf } from "./maneuver";
import { SpotifySource } from "./music/spotify";
import { lazy, type MusicSource, type NowPlaying } from "./music/source";
import { Voice } from "./voice";
import { RouteWatch, phraseFor, type Feature } from "./warnings";
import type { Health, LonLat, Place, Provider, Route } from "./types";

// A key-free vector style; swap for a Mapbox/VWorld style URL through
// VITE_MAP_STYLE once Korean coverage has been compared in the car.
const HOME: LonLat = [127.0276, 37.4979];
/** ?demo: a made-up trip fills the panel, for judging the layout at a desk. */
const demo = new URLSearchParams(location.search).has("demo");
const style: string = import.meta.env.VITE_MAP_STYLE ?? "https://tiles.openfreemap.org/styles/liberty";
// Where the tiles cannot be reached, a plain ground so the page still works
// (and the demo still runs) — offline at a desk, or a dead tile server.
const STYLE_WAIT_S = 8;
const GROUND: maplibregl.StyleSpecification = {
  version: 8, sources: {}, layers: [{ id: "ground", type: "background", paint: { "background-color": "#e6e2d8" } }],
};
const NAMES: Record<Provider, string> = { tmap: "티맵", kakao: "카카오", naver: "네이버", osrm: "OSM" };
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
    const m = new maplibregl.Map({ container: "map", style, center: HOME, zoom: 15, pitch: 45, attributionControl: false });
    // A style that fails, or one that simply never comes (a dead link
    // hangs rather than refuses), gives way to the plain ground so the
    // rest of the page can go on; the log says so.
    let grounded = false;
    const ground = (why: string) => {
      if (grounded || m.isStyleLoaded()) return;
      grounded = true;
      log(`지도 스타일을 못 받음 (${why}) — 빈 바닥으로`);
      m.setStyle(GROUND);
    };
    m.on("error", (e) => ground((e as { error?: Error }).error?.message ?? "오류"));
    window.setTimeout(() => ground(`${STYLE_WAIT_S}초 무응답`), STYLE_WAIT_S * 1000);
    return m;
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
  el("recenter").hidden = on;
  if (on && gps.last) map.easeTo({ center: [gps.last.lon, gps.last.lat], pitch: 45, zoom: Math.max(map.getZoom(), 16) });
}
map.on("dragstart", () => setFollow(false));

/** Where a route starts: the car, or the map's middle before the first fix. */
function here(): LonLat {
  const last = gps.last;
  if (last) return [last.lon, last.lat];
  const c = map.getCenter();
  return [c.lng, c.lat];
}

// ---- the trip --------------------------------------------------------------
// Three screens, the way the car apps do it: where to; the ways there,
// as cards, with every offer on the map and the chosen one in colour;
// then the drive — the turn, the one after, the arrival time. 경로 on the
// way brings the cards back without stopping the guidance.

type Screen = "search" | "preview" | "drive";
let health: Health | null = null;
let goal: Place | null = null;
/** Every provider's answer for this goal, quickest first, and the one chosen. */
let offers: Route[] = [];
let chosen: Route | null = null;
/** The route being driven; null before 안내 시작. */
let route: Route | null = null;
let recheck: number | null = null;
let rerouting = false;
const routeLayer = new RouteLayer(map);

function showScreen(name: Screen) {
  el("s-search").hidden = name !== "search";
  el("s-preview").hidden = name !== "preview";
  el("s-drive").hidden = name !== "drive";
  el("go").textContent = route ? "이 경로로" : "안내 시작";
}

// -- 1. where to --

async function search(q: string) {
  const results = el<HTMLUListElement>("results");
  results.replaceChildren();
  results.hidden = false;
  el("recent-box").hidden = true;
  try {
    const places = await api.search(q, gps.last ? here() : undefined);
    if (places.length === 0) results.append(item("결과 없음", ""));
    for (const p of places) {
      const li = item(p.name, `${p.address}${p.distanceM != null ? ` · ${km(p.distanceM)}` : ""}`);
      li.addEventListener("click", () => void choose(p));
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

/** The last few places driven to, kept in the browser. */
function recents(): Place[] {
  try { return JSON.parse(localStorage.getItem("nav-recent") ?? "[]"); } catch { return []; }
}
function remember(place: Place) {
  const kept = [place, ...recents().filter((p) => p.name !== place.name)].slice(0, 6);
  try { localStorage.setItem("nav-recent", JSON.stringify(kept)); } catch { /* private window */ }
}
function drawRecents() {
  const list = recents();
  const ul = el<HTMLUListElement>("recent");
  ul.replaceChildren();
  for (const p of list) {
    const li = item(p.name, p.address);
    li.addEventListener("click", () => void choose(p));
    ul.append(li);
  }
  el("recent-box").hidden = list.length === 0;
}

el<HTMLFormElement>("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = el<HTMLInputElement>("q");
  const q = input.value.trim();
  input.blur();
  if (!q) return;
  // A bare "lon,lat" routes without a search key, for the desk.
  const m = q.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (m) void choose({ name: q, address: "", at: [Number(m[1]), Number(m[2])] });
  else void search(q);
});

// -- 2. the ways there --

/** A destination picked: ask everyone, show the cards. */
async function choose(place: Place) {
  goal = place;
  el("results").hidden = true;
  el("pv-name").textContent = place.name;
  el("pv-addr").textContent = place.address;
  el("pv-msg").textContent = "경로 찾는 중…";
  el("offers").replaceChildren();
  showScreen("preview");
  await fetchOffers();
}

async function fetchOffers(): Promise<boolean> {
  if (!goal) return false;
  try {
    const answer = await api.routes(here(), goal.at);
    for (const e of answer.errors) log(`경로 실패 ${e}`);
    if (answer.routes.length === 0) throw new Error(answer.errors.join("; ") || "경로 없음");
    offers = answer.routes.sort((a, b) => a.durationS - b.durationS);
    // Keep the driven provider if it answered again, else the quickest.
    chosen = offers.find((r) => r.provider === (chosen ?? route)?.provider) ?? offers[0];
    el("pv-msg").textContent = "";
    drawOffers();
    routeLayer.show(chosen, offers);
    setFollow(false);
    routeLayer.fit(...offers);
    log(`경로 ${offers.map((r) => `${r.provider} ${minutes(r.durationS)}`).join(", ")}`);
    return true;
  } catch (e) {
    el("pv-msg").textContent = `경로 실패: ${(e as Error).message}`;
    return false;
  }
}

function drawOffers() {
  const ul = el<HTMLUListElement>("offers");
  ul.replaceChildren();
  const quickest = offers[0];
  const shortest = [...offers].sort((a, b) => a.distanceM - b.distanceM)[0];
  for (const r of offers) {
    const li = document.createElement("li");
    li.className = "offer" + (r === chosen ? " on" : "");
    const tag = r === quickest ? `<span class="tag">가장 빠름</span>` : r === shortest ? `<span class="tag alt">최단 거리</span>` : "";
    li.innerHTML =
      `<div class="l1"><b>${minutes(r.durationS)}</b><span>${arrivalAt(r.durationS)} 도착</span>${tag}</div>` +
      `<div class="l2">${km(r.distanceM)} · ${NAMES[r.provider]}${r.provider === "osrm" ? " (교통 정보 없음)" : ""}</div>` +
      `<div class="bar">${trafficBar(r)}</div>`;
    li.addEventListener("click", () => {
      chosen = r;
      drawOffers();
      routeLayer.show(chosen, offers);
    });
    ul.append(li);
  }
}

/** The road's colours in proportion, as a strip. */
function trafficBar(r: Route): string {
  const line = new Line(r.path);
  const parts: string[] = [];
  for (const s of r.segments) {
    const a = line.along[Math.min(s.from, r.path.length - 1)];
    const b = line.along[Math.min(s.to, r.path.length - 1)];
    const share = line.lengthM ? ((b - a) / line.lengthM) * 100 : 0;
    if (share > 0) parts.push(`<i class="c${s.congestion}" style="width:${share}%"></i>`);
  }
  return parts.join("");
}

el("go").addEventListener("click", () => {
  if (chosen) startDrive(chosen);
});
el("pv-close").addEventListener("click", () => {
  if (route) {
    // Back to the drive as it was.
    routeLayer.show(route);
    showScreen("drive");
    setFollow(true);
  } else {
    goal = null;
    offers = [];
    chosen = null;
    routeLayer.show(null);
    showScreen("search");
    setFollow(true);
  }
});

// -- 3. on the way --

function startDrive(r: Route) {
  const fresh = route == null;
  route = r;
  chosen = r;
  routeLayer.show(route);
  tracker.setRoute(route);
  sim?.follow(route);
  watch = new RouteWatch(route);
  watchedAt = null;
  turnsSaid.clear();
  arrived = false;
  showScreen("drive");
  setFollow(true);
  if (goal) remember(goal);
  if (fresh) voice.say("안내를 시작합니다");
  if (recheck == null) recheck = window.setInterval(() => void recheckRoute(), RECHECK_MS);
}

function endDrive() {
  route = null;
  goal = null;
  offers = [];
  chosen = null;
  routeLayer.show(null);
  tracker.setRoute(null);
  watch = null;
  if (recheck != null) clearInterval(recheck);
  recheck = null;
  el("turn-icon").replaceChildren();
  drawRecents();
  showScreen("search");
  setFollow(true);
}

el("end").addEventListener("click", endDrive);
el("routes").addEventListener("click", async () => {
  showScreen("preview");
  el("pv-msg").textContent = "경로 다시 찾는 중…";
  await fetchOffers();
});

/** Every few minutes on the way: a much quicker route from any provider wins. */
async function recheckRoute() {
  if (!goal || !route || !gps.last || rerouting) return;
  if (!el("s-preview").hidden) return; // the cards are open; the driver is choosing
  const current = tracker.frame()?.remainingS ?? route.durationS;
  try {
    const answer = await api.routes(here(), goal.at);
    const best = answer.routes.sort((a, b) => a.durationS - b.durationS)[0];
    if (best && best.durationS < current - BETTER_BY_S) {
      offers = answer.routes;
      log(`더 빠른 길: ${best.provider} ${minutes(best.durationS)} (지금 ${minutes(current)})`);
      voice.say("더 빠른 길로 안내합니다");
      startDrive(best);
    }
  } catch (e) {
    log(`재확인 실패 ${(e as Error).message}`);
  }
}

// Off the road for three seconds: the route is asked again from here.
tracker.onOffRoute = async () => {
  if (!goal || !route || rerouting) return;
  rerouting = true;
  log("경로 이탈 — 재탐색");
  voice.say("경로를 벗어나 다시 찾습니다");
  el("eta-left").textContent = "경로 이탈 · 재탐색 중…";
  try {
    const answer = await api.routes(here(), goal.at);
    const again = answer.routes.sort((a, b) => a.durationS - b.durationS);
    const same = again.find((r) => r.provider === route!.provider) ?? again[0];
    if (same) {
      offers = again;
      startDrive(same);
    }
  } catch (e) {
    log(`재탐색 실패 ${(e as Error).message}`);
  } finally {
    rerouting = false;
  }
};

/** Distances at which a turn is spoken; each once per guide. */
const TURN_RUNGS_M = [500, 150];
const turnsSaid = new Map<string, Set<number>>();
let arrived = false;

function showTurn(shown: Shown) {
  if (!route) return;
  if (shown.remainingM != null && shown.remainingS != null) {
    el("eta-time").textContent = arrivalAt(shown.remainingS);
    el("eta-left").textContent = `${minutes(shown.remainingS)} · ${km(shown.remainingM)} · ${NAMES[route.provider]}`;
  }
  if (!shown.nextGuide) {
    if (shown.remainingM != null && shown.remainingM < 30 && !arrived) {
      arrived = true;
      voice.say("목적지에 도착했습니다");
      el("turn-icon").innerHTML = arrowSvg("arrive");
      el("turn-in").textContent = "도착";
      el("turn-text").textContent = goal?.name ?? "";
      el("then").hidden = true;
    }
    return;
  }
  const g = shown.nextGuide.guide;
  el("turn-icon").innerHTML = arrowSvg(maneuverOf(route.provider, g));
  el("turn-in").textContent = km(shown.nextGuide.inM);
  el("turn-text").textContent = g.text;
  if (shown.thenGuide && shown.thenGuide.inM - shown.nextGuide.inM < 800) {
    el("then").hidden = false;
    el("then-icon").innerHTML = arrowSvg(maneuverOf(route.provider, shown.thenGuide.guide), 20);
    el("then-text").textContent = `${km(shown.thenGuide.inM - shown.nextGuide.inM)} 후 ${shown.thenGuide.guide.text}`;
  } else {
    el("then").hidden = true;
  }
  const key = `${g.at[0]},${g.at[1]}`;
  const said = turnsSaid.get(key) ?? new Set<number>();
  for (const rung of TURN_RUNGS_M) {
    if (said.has(rung) || shown.nextGuide.inM > rung) continue;
    said.add(rung);
    turnsSaid.set(key, said);
    voice.say(`${rung}미터 앞 ${g.text}`);
    break;
  }
}

const km = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const minutes = (s: number) => (s < 3600 ? `${Math.round(s / 60)}분` : `${Math.floor(s / 3600)}시간 ${Math.round((s % 3600) / 60)}분`);
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const arrivalAt = (inS: number) => hhmm(new Date(Date.now() + inS * 1000));

// The clock in the corner, as every car shows one.
setInterval(() => { el("clock").textContent = hhmm(new Date()); }, 1000);
el("clock").textContent = hhmm(new Date());
drawRecents();

// Back onto the car, when the map was dragged away.
el("recenter").addEventListener("click", () => setFollow(true));

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
// The dock is a mini bar (art, title, ⏯ ⏭) that opens into the full
// player — tabs for the connected services, big art, progress, transport,
// playlists. Choosing something to play closes it again: the map is what
// the driver should be looking at.

const sources: MusicSource[] = [
  new SpotifySource(),
  lazy("tidal", "TIDAL", async () => new (await import("./music/tidal")).TidalSource()),
];
let music: MusicSource | null = null;
let now: NowPlaying = { playing: false };
let nowAt = 0;

function musicSay(text: string, bad = false) {
  el("music-msg").textContent = text;
  el("music-msg").style.color = bad ? "#ff4d4f" : "";
}

function openDock(open: boolean) {
  el("music-dock").classList.toggle("closed", !open);
}
el("mini").addEventListener("click", () => openDock(el("music-dock").classList.contains("closed")));

async function drawSources() {
  if (demo) return;
  const row = el("music-sources");
  row.replaceChildren();
  let state: Record<string, { connected: boolean }> = {};
  try { state = await (await fetch("/api/music/state")).json(); } catch { /* server away */ }
  const connected = sources.filter((s) => state[s.id]?.connected);
  for (const s of connected) {
    const b = document.createElement("button");
    b.textContent = s.label;
    b.classList.toggle("on", s === music);
    b.addEventListener("click", () => void pickSource(s));
    row.append(b);
  }
  if (connected.length === 0) {
    el("mini-artist").textContent = "설정 페이지에서 계정을 연결하세요";
    musicSay("연결된 음악 계정이 없습니다. /admin 에서 Spotify 나 TIDAL 을 연결하면 여기에 나타납니다.");
  }
}

async function pickSource(s: MusicSource) {
  if (music === s) return;
  if (music) {
    music.disconnect();
    voice.duckers.delete(duckBySource);
  }
  music = s;
  showNow({ playing: false });
  el("player").hidden = true;
  el("music-lists").hidden = true;
  musicSay(`${s.label} 연결 중…`);
  await drawSources();
  try {
    await s.connect();
    s.onState(showNow);
    voice.duckers.add(duckBySource);
    el("player").hidden = false;
    el("mini-artist").textContent = s.label;
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

function showNow(state: NowPlaying) {
  now = state;
  nowAt = performance.now();
  const has = !!state.title;
  el("mini-title").textContent = state.title ?? "음악";
  el("mini-artist").textContent = state.artist ?? music?.label ?? "Spotify · TIDAL";
  el("now-title").textContent = state.title ?? "";
  el("now-artist").textContent = state.artist ?? "";
  for (const id of ["mini-art", "now-art"]) {
    el(id).style.backgroundImage = state.art ? `url("${state.art}")` : "";
  }
  const glyph = state.playing ? "⏸" : "▶";
  el("mini-toggle").textContent = glyph;
  el("music-toggle").textContent = glyph;
  el("mini-toggle").hidden = !has;
  el("mini-next").hidden = !has;
  drawProgress();
}

/** The bar moves between state events while the track plays. */
function drawProgress() {
  if (now.durationS == null || now.positionS == null) {
    el("progress-bar").style.width = "0";
    return;
  }
  const elapsed = now.playing ? (performance.now() - nowAt) / 1000 : 0;
  const at = Math.min(now.durationS, now.positionS + elapsed);
  el("progress-bar").style.width = `${(at / now.durationS) * 100}%`;
}
setInterval(drawProgress, 1000);

async function showLists() {
  if (!music) return;
  const ul = el<HTMLUListElement>("music-lists");
  ul.replaceChildren();
  try {
    const lists = await music.playlists();
    for (const p of lists) {
      const li = item(p.name, p.count != null ? `${p.count}곡` : "");
      li.addEventListener("click", async () => {
        try {
          await music!.play(p.uri);
          openDock(false);
        } catch (e) {
          musicSay((e as Error).message, true);
        }
      });
      ul.append(li);
    }
    ul.hidden = lists.length === 0;
  } catch (e) {
    musicSay((e as Error).message, true);
  }
}

const onMusicError = (e: Error) => musicSay(e.message, true);
el("music-toggle").addEventListener("click", () => void music?.toggle().catch(onMusicError));
el("music-next").addEventListener("click", () => void music?.next().catch(onMusicError));
el("music-prev").addEventListener("click", () => void music?.previous().catch(onMusicError));
el("mini-toggle").addEventListener("click", (e) => { e.stopPropagation(); void music?.toggle().catch(onMusicError); });
el("mini-next").addEventListener("click", (e) => { e.stopPropagation(); void music?.next().catch(onMusicError); });
void drawSources();

// ---- a pretend drive -------------------------------------------------------

let sim: Simulator | null = null;

function simSpeed(): number {
  return Number(el<HTMLInputElement>("sim-speed").value) / 3.6;
}
el<HTMLInputElement>("sim-speed").addEventListener("input", () => {
  el("sim-speed-label").textContent = el<HTMLInputElement>("sim-speed").value;
  if (sim) sim.speedMps = simSpeed();
});
function startSim() {
  if (!route) { log("모의 주행: 먼저 경로가 있어야 합니다"); return; }
  sim?.stop();
  sim = new Simulator(gps, route);
  sim.speedMps = simSpeed();
  sim.onEnd = () => { el("sim-toggle").classList.remove("on"); log("모의 주행 끝"); };
  sim.start();
  el("sim-toggle").classList.add("on");
  log(`모의 주행 시작 ${Math.round(sim.speedMps * 3.6)} km/h`);
}
function stopSim() {
  sim?.stop();
  el("sim-toggle").classList.remove("on");
  gps.start();
}
el("sim-toggle").addEventListener("click", () => (sim?.running ? stopSim() : startSim()));
el("sim-tunnel").addEventListener("click", () => { sim?.tunnel(10); log("터널: 10초간 GPS 없음"); });
el("sim-stray").addEventListener("click", () => { sim?.stray(8); log("이탈: 60 m 옆으로 8초"); });

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

// ---- a made-up drive, for the desk --------------------------------------
// ?demo fills the panel as it looks mid-trip — route, turn, offers, a song —
// with no server, no car and no account, so the layout can be judged.

// The demo's road is asked for at once, not after the map (which may be
// eight seconds coming): Gangnam station → Seolleung from OSRM, else a curve.
const demoRoad: Promise<Route | null> | null = demo
  ? api.route("osrm", HOME, [127.0489, 37.5045]).then((r) => { log(`데모 경로: OSM 도로 ${r.path.length}점`); return r; })
    .catch((e) => { log(`데모 경로: OSRM 못 닿음 (${(e as Error).message}) — 그린 곡선`); return null; })
  : null;

if (demo) map.once("load", async () => {
  const real = await demoRoad;
  let path: LonLat[] = real?.path ?? [];
  if (path.length === 0) {
    for (let i = 0; i <= 60; i++) path.push([HOME[0] + i * 0.0006, HOME[1] + Math.sin(i / 8) * 0.0015 + i * 0.0003]);
  }
  const n = path.length;
  const q = (k: number) => Math.round((n - 1) * k);
  const fake = (provider: Provider, durationS: number): Route => ({
    provider, distanceM: real?.distanceM ?? 4200, durationS, path,
    guides: real?.guides ?? [
      { at: path[q(0.33)], text: "테헤란로 방면 우회전", distanceM: 1300, turnType: 12 },
      { at: path[q(0.75)], text: "선릉로 방면 좌회전", distanceM: 1600, turnType: 13 },
    ],
    // Traffic is painted on, since the free road has none.
    segments: [
      { from: 0, to: q(0.25), congestion: 1 }, { from: q(0.25), to: q(0.5), congestion: 2 },
      { from: q(0.5), to: q(0.7), congestion: 3 }, { from: q(0.7), to: n, congestion: 1 },
    ],
  });
  health = { ok: true, providers: { tmap: true, kakao: true, naver: true, osrm: true }, safetyFeatures: 48210, search: true, tts: true };
  goal = { name: "스타벅스 선릉역점", address: "서울 강남구 테헤란로 340", at: path[n - 1] };
  offers = [fake("kakao", 14 * 60), fake("tmap", 16 * 60), fake("naver", 19 * 60)];
  chosen = offers[0];
  el("pv-name").textContent = goal.name;
  el("pv-addr").textContent = goal.address;
  drawOffers();
  if (new URLSearchParams(location.search).get("screen") === "preview") {
    showScreen("preview");
    routeLayer.show(chosen, offers);
    routeLayer.fit(...offers);
  } else {
    startDrive(offers[0]);
    startSim();
  }
  const row = el("music-sources");
  for (const [name, on] of [["Spotify", true], ["TIDAL", false]] as const) {
    const b = document.createElement("button");
    b.textContent = name;
    b.classList.toggle("on", on);
    row.append(b);
  }
  el("player").hidden = false;
  showNow({ playing: true, title: "Blue in Green", artist: "Miles Davis", positionS: 97, durationS: 337 });
  const lists = el("music-lists");
  for (const [name, n] of [["Drive", 48], ["Jazz at Night", 120], ["Daily Mix 1", 50]] as const) lists.append(item(name, `${n}곡`));
  lists.hidden = false;
  if (new URLSearchParams(location.search).get("dock") === "open") openDock(true);
  setFollow(true);
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
