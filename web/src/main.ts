import maplibregl from "maplibre-gl";
import { api } from "./api";
import { Gps, type Fix } from "./gps";
import { chime, keepAwake } from "./probes";
import { Replay } from "./replay";
import { Simulator } from "./simulate";
import { RouteLayer } from "./route-layer";
import { Tracker, type Shown } from "./tracker";
import { Line, lerpAngle, metres } from "./geo";
import { arrowSvg, maneuverOf } from "./maneuver";
import { lazy, type MusicSource, type NowPlaying, type Playlist } from "./music/source";
import { debounce, matches } from "./music/find";
import { deep, pastel, tintOf } from "./music/tint";
import { Voice } from "./voice";
import { RouteWatch, phraseFor, type Feature } from "./warnings";
import { Nearby } from "./nearby";
import { autoZoom } from "./autozoom";
import { EVENTS, turnSpeech } from "./speech";
import { drawGuide, loadGuide, wants, type VoiceList } from "./guide-settings";
import { WeatherPanel } from "./weather";
import { isFavourite, loadPlaces, samePlace, savePlaces, toggleFavourite } from "./places";
import { OVERLAY_STYLE, TmapBase, tmapAvailable } from "./tmap-base";
import { NaverBase, naverAvailable } from "./naver-base";
import type { Health, LonLat, Place, Provider, Route } from "./types";

// The ground: TMAP's or NAVER's own vector map when the server has their
// keys (Korean roads as they know them: tmap-base.ts, naver-base.ts), else
// a key-free OpenStreetMap style — or any style URL through VITE_MAP_STYLE.
// The 지도 button goes round the ones that are there.
const HOME: LonLat = [127.0276, 37.4979];
/** ?demo: a made-up trip fills the panel, for judging the layout at a desk. */
const demo = new URLSearchParams(location.search).has("demo");
// The 진단 panel (sound test, GPS log, pretend drive) is for checking the
// car and the desk, not for driving: shown with ?debug, or in the demo.
if (!demo && !new URLSearchParams(location.search).has("debug")) document.getElementById("diag")!.hidden = true;
const OSM_STYLE: string = import.meta.env.VITE_MAP_STYLE ?? "https://tiles.openfreemap.org/styles/liberty";
type Base = "tmap" | "naver" | "osm";
const BASE_ORDER: Base[] = ["tmap", "naver", "osm"];
const BASE_NAMES: Record<Base, string> = { tmap: "티맵", naver: "네이버", osm: "OSM" };
const baseReady = (b: Base) => (b === "tmap" ? tmapAvailable() : b === "naver" ? naverAvailable() : true);
let base: Base = (() => {
  let kept: string | null = null;
  try { kept = localStorage.getItem("nav-base"); } catch { /* private window */ }
  const want = BASE_ORDER.includes(kept as Base) ? (kept as Base) : "tmap";
  return baseReady(want) ? want : BASE_ORDER.find(baseReady)!;
})();
const style = base === "osm" ? OSM_STYLE : OVERLAY_STYLE;
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
    //
    // Only the style itself: once it has come, a tile that fails or is slow
    // (a patchy link in the car) is MapLibre's to retry, never a reason to
    // wipe the map. isStyleLoaded() cannot tell the two apart — it is false
    // whenever tiles are still loading — so the arrival is kept here.
    let arrived = false;
    let grounded = false;
    m.once("style.load", () => { arrived = true; });
    const ground = (why: string) => {
      if (grounded || arrived || base !== "osm") return;
      grounded = true;
      log(`지도 스타일을 못 받음 (${why}) — 빈 바닥으로`);
      m.setStyle(GROUND);
    };
    m.on("error", (e) => {
      const message = (e as { error?: Error }).error?.message ?? "오류";
      if (arrived) log(`지도 타일 오류 (다시 받음): ${message.slice(0, 120)}`);
      else ground(message);
    });
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

// An arrow lying flat on the road, turned with the car: the way every car
// app draws "you", and it tilts with the map in 3D.
const car = document.createElement("div");
car.className = "car";
car.innerHTML = `<svg viewBox="0 0 48 48" width="44" height="44"><path d="M24 4 39 41 24 33 9 41z" fill="#1a73e8" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/></svg>`;
const marker = new maplibregl.Marker({ element: car, rotationAlignment: "map", pitchAlignment: "map" }).setLngLat(HOME);

// ---- the camera ------------------------------------------------------------
// Three ways to look, as the car apps offer them: 3D (tilted, heading up,
// buildings standing), 2D heading up, and 2D north up. Following the car,
// the car sits low on the screen with the road ahead above it, right of
// the trip panel. A finger that drags, turns or tilts the map lets go of
// the car — 현위치 takes it back, and on the way it goes back by itself
// after a while. Pinching only zooms, and the car stays followed.

type View = "3d" | "heading" | "north";
// Zoom follows the speed (autozoom.ts); each view only shifts it — flat
// views a little further out, since they show no road beyond the top edge.
const VIEWS: Record<View, { pitch: number; zoomShift: number; label: string; /** Share of the height pushed above the car. */ carLow: number }> = {
  "3d": { pitch: 55, zoomShift: 0, label: "3D", carLow: 0.4 },
  heading: { pitch: 0, zoomShift: -0.4, label: "2D", carLow: 0.28 },
  north: { pitch: 0, zoomShift: -0.6, label: "북쪽", carLow: 0 },
};
const ORDER: View[] = ["3d", "heading", "north"];
/** Left alone this long after a hand moved it, the map goes back to the car. */
const RETURN_MS = 5_000;
let view: View = (() => {
  try { const v = localStorage.getItem("nav-view") as View; return v in VIEWS ? v : "3d"; } catch { return "3d"; }
})();
let follow = true;
/** What a pinch or ± added to the speed's zoom while following; 현위치 clears it. */
let zoomBias = 0;
/** The speed the zoom goes by, smoothed so a jerky fix does not bob the camera. */
let zoomSpeed = 0;
let turnInM: number | undefined;
/** The zoom to follow at, before the driver's own bias. */
const speedZoom = () => autoZoom(zoomSpeed, turnInM, VIEWS[view].zoomShift);
/** Gliding back to the car rather than jumping. */
let returning = false;
/** Fingers (or the mouse button) down on the map, by pointer id. */
const hands = new Set<number>();
/** The wheel was turned just now; its zoom animation is still going. */
let wheelUntil = 0;
let touchedAt = 0;
/** Where on the screen the car sits while followed; eases when a side panel opens. */
let spot: { x: number; y: number } | null = null;
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
    marker.setRotation(shown.bearing);
    zoomSpeed += (shown.speedMps * 3.6 - zoomSpeed) * 0.01;
    turnInM = route ? shown.nextGuide?.inM : undefined;
    if (follow && !handsOn()) followCar(shown.at);
    showTurn(shown);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const approach = (from: number, to: number, k: number) => (Math.abs(to - from) < 0.005 ? to : from + (to - from) * k);

/** One frame of following: everything eases toward where it should be. */
function followCar(at: LonLat) {
  const v = VIEWS[view];
  const want = carSpot(v.carLow);
  spot = spot ? { x: approach(spot.x, want.x, 0.15), y: approach(spot.y, want.y, 0.15) } : want;
  const before = map.getCenter();
  const camera = {
    bearing: view === "north" ? lerpAngle(map.getBearing(), 0, 0.15) : tracker.cameraBearing(map.getBearing()),
    pitch: approach(map.getPitch(), v.pitch, 0.12),
    // Quick when coming back to the car; slow as the speed changes, like a drive.
    zoom: approach(map.getZoom(), Math.max(10, Math.min(20, speedZoom() + zoomBias)), returning ? 0.12 : 0.03),
  };
  let center = centreFor(at, spot, camera);
  if (returning) {
    const eased: LonLat = [before.lng + (center[0] - before.lng) * 0.15, before.lat + (center[1] - before.lat) * 0.15];
    if (metres(eased[0], eased[1], center[0], center[1]) < 1) returning = false;
    center = eased;
  }
  map.jumpTo({ center, ...camera });
}

/**
 * The camera centre that puts [at] at screen point [to]. This is what
 * padding would do, but TMAP's camera takes no padding, so both maps keep
 * a plain centre and the car is placed by moving it: aim at the car, slide
 * by the offset, then once more for the tilt's perspective.
 */
function centreFor(at: LonLat, to: { x: number; y: number }, camera: { bearing: number; pitch: number; zoom: number }): LonLat {
  const canvas = map.getCanvas();
  const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
  map.jumpTo({ center: at, ...camera });
  let q = map.unproject([2 * cx - to.x, 2 * cy - to.y]);
  map.jumpTo({ center: q });
  const p = map.project(at);
  q = map.unproject([cx + p.x - to.x, cy + p.y - to.y]);
  return [q.lng, q.lat];
}

/** The middle of the map's free part — right of the trip panel, left of whatever holds the right side — lowered by [carLow]. */
function carSpot(carLow = 0) {
  const canvas = map.getCanvas();
  const hud = el("hud").getBoundingClientRect();
  const side = !el("nearby").hidden || !el("guide").hidden || !el("weather").hidden || !el("music-dock").classList.contains("closed");
  const right = canvas.clientWidth - (side ? 356 : 76);
  return { x: (hud.right + right) / 2, y: (canvas.clientHeight * (1 + carLow)) / 2 };
}

function setFollow(on: boolean) {
  if (on) {
    if (!follow) returning = true;
    zoomBias = 0;
  }
  const changed = follow !== on;
  follow = on;
  el("locate").classList.toggle("on", on);
  if (changed) showBasePlaces();
}

// Hands on the map: the camera is left alone the whole time, from the
// press — not from MapLibre's movestart, which comes a frame later. A
// jumpTo in between calls map.stop(), which resets the gesture handlers,
// so a drag that had not yet passed its few pixels never began and the
// map would not move while the car was followed.
function handsOn() {
  return hands.size > 0 || Date.now() < wheelUntil || map.isEasing();
}
const box = map.getCanvasContainer();
box.addEventListener("pointerdown", (e) => { hands.add(e.pointerId); touchedAt = Date.now(); }, true);
let wheelDone = 0;
box.addEventListener("wheel", () => {
  wheelUntil = Date.now() + 400;
  touchedAt = Date.now();
  // The wheel's zoom is the one to keep following at, once it settles.
  clearTimeout(wheelDone);
  wheelDone = window.setTimeout(keepHandZoom, 420);
}, { capture: true, passive: true });
for (const kind of ["pointerup", "pointercancel"] as const) {
  window.addEventListener(kind, (e) => {
    if (!hands.delete(e.pointerId) || hands.size > 0 || !follow) return;
    // A pinch while following: keep its zoom, and glide back onto the car
    // it may have slid away from.
    keepHandZoom();
    returning = true;
  }, true);
}
// Dragging, turning or tilting by hand lets go of the car; a pinch or the
// wheel only zooms, and the zoom it leaves is kept while following.
type Moved = { originalEvent?: Event };
for (const kind of ["dragstart", "rotatestart", "pitchstart"] as const) {
  map.on(kind, (e: Moved) => { if (e.originalEvent) setFollow(false); });
}
map.on("move", (e: Moved) => { if (e.originalEvent) touchedAt = Date.now(); });
map.on("zoomend", (e: Moved) => { if (e.originalEvent) keepHandZoom(); });
/** A zoom by hand while following is kept as a lean on the speed's zoom, not a fixed level. */
function keepHandZoom() {
  if (follow) zoomBias = Math.max(-4, Math.min(2.5, map.getZoom() - speedZoom()));
}
// A map left alone goes back to the car, driving or not — except while
// the route cards are up or a place is open on the 주변 sheet, when it was
// moved there on purpose, and never under a finger that is still down.
setInterval(() => {
  if (follow || !gps.last || handsOn() || !el("s-preview").hidden || nearby.isOpen) return;
  if (Date.now() - touchedAt > RETURN_MS) setFollow(true);
}, 500);

function setView(next: View) {
  view = next;
  try { localStorage.setItem("nav-view", view); } catch { /* private window */ }
  const v = VIEWS[view];
  el("view-label").textContent = v.label;
  el("view-ic").style.transform = view === "north" ? "" : view === "3d" ? "perspective(40px) rotateX(28deg)" : "";
  el("view-mode").classList.toggle("on", view !== "north");
  zoomBias = 0;
  showBuildings();
  // Following, the frame eases there; off the car, the map turns on the spot.
  if (!follow) map.easeTo({ pitch: v.pitch, bearing: view === "north" ? 0 : map.getBearing(), duration: 500 });
}
/** Standing buildings are for the tilted view; flat, they only cost frames. */
function showBuildings() {
  try {
    if (map.getLayer("building-3d")) map.setLayoutProperty("building-3d", "visibility", view === "3d" ? "visible" : "none");
  } catch { /* the style is not in yet; style.load comes back here */ }
}
/**
 * The style's own shop and restaurant icons, off while following: in a
 * view that moves every frame they flicker in and out of placement, and
 * on the way the driver wants the road. The 주변 buttons bring back the
 * kinds that matter. Back on when the map is browsed by hand.
 */
function showBasePlaces() {
  for (const id of ["poi_r1", "poi_r7", "poi_r20"]) {
    try {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", follow ? "none" : "visible");
    } catch { /* style not in yet */ }
  }
}
map.on("style.load", () => { showBuildings(); showBasePlaces(); });
el("view-mode").addEventListener("click", () => setView(ORDER[(ORDER.indexOf(view) + 1) % ORDER.length]));

// ---- the ground --------------------------------------------------------------

let ground: TmapBase | NaverBase | null = null;
/** Onto [next]: the other ground away, MapLibre's own style swapped only to or from OSM. */
function setBase(next: Base, remember = true) {
  if (!baseReady(next)) next = BASE_ORDER.find(baseReady)!;
  const was = base;
  base = next;
  if (remember) try { localStorage.setItem("nav-base", base); } catch { /* private window */ }
  // A refused NAVER map can throw on the way out; it must not keep the switch from happening.
  try { ground?.destroy(); } catch (e) { log(`바탕 지도 정리 오류 ${(e as Error).message}`); }
  el("ground").replaceChildren();
  ground = null;
  if ((was === "osm") !== (base === "osm")) map.setStyle(base === "osm" ? OSM_STYLE : OVERLAY_STYLE);
  try {
    if (base === "tmap") ground = new TmapBase(el("ground"), map);
    if (base === "naver") ground = new NaverBase(el("ground"), map);
  } catch (e) {
    log(`${BASE_NAMES[base]} 지도 실패 ${(e as Error).message} — OSM 으로`);
    return setBase("osm", false);
  }
  el("base-label").textContent = BASE_NAMES[base];
  el("osm-credit").hidden = base !== "osm";
  drawBaseMenu();
}

/** What each ground is, and why one cannot be chosen right now. */
function baseNote(b: Base): string {
  if (b === "osm") return "오픈스트리트맵 · 키 없이 · 한국 골목은 빠지기도";
  if (baseReady(b)) return b === "tmap" ? "티맵 도로망 · 혼잡도와 같은 데이터" : "네이버 지도 · 상호와 건물이 자세함";
  if (b === "naver" && window.naverRefused) return `인증 실패 — NCP 콘솔 Web 서비스 URL 에 ${location.origin}`;
  return "서버에 키가 없음 (/admin)";
}
function drawBaseMenu() {
  const box = el("base-options");
  box.replaceChildren();
  for (const b of BASE_ORDER) {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("on", b === base);
    button.disabled = !baseReady(b);
    button.innerHTML = `<b></b><small></small>`;
    button.querySelector("b")!.textContent = BASE_NAMES[b] + (b === base ? " ✓" : "");
    button.querySelector("small")!.textContent = baseNote(b);
    button.addEventListener("click", () => {
      el("base-menu").hidden = true;
      if (b !== base) setBase(b);
    });
    box.append(button);
  }
}
el("base-mode").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = el("base-menu");
  if (menu.hidden) {
    drawBaseMenu();
    const at = el("base-mode").getBoundingClientRect();
    menu.style.top = `${at.top}px`;
  }
  menu.hidden = !menu.hidden;
});
// A tap anywhere else closes the list.
document.addEventListener("pointerdown", (e) => {
  const menu = el("base-menu");
  if (!menu.hidden && !menu.contains(e.target as Node) && !el("base-mode").contains(e.target as Node)) menu.hidden = true;
});
// NAVER says no only after its script has run (the key's settings are
// checked on its server): off its ground, and out of the round.
function naverRefused() {
  log(`네이버 지도 인증 실패 — NCP 콘솔 Maps 앱의 Web 서비스 URL 에 ${location.origin} 이 있는지 확인하세요`);
  if (base === "naver") setBase(BASE_ORDER.find(baseReady)!, false);
  else drawBaseMenu();
}
window.addEventListener("naver-refused", naverRefused);
setBase(base, false);
// The refusal can come before this module runs (its answer races the
// page's own scripts), so it is looked for once more here.
if (window.naverRefused) naverRefused();
el("locate").addEventListener("click", () => setFollow(true));
for (const [id, by] of [["zoom-in", 1], ["zoom-out", -1]] as const) {
  el(id).addEventListener("click", () => {
    if (follow) zoomBias = Math.max(-4, Math.min(2.5, zoomBias + by));
    else { touchedAt = Date.now(); map.easeTo({ zoom: map.getZoom() + by, duration: 300 }); }
  });
}

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
/** The place whose routes are on the cards. */
let goal: Place | null = null;
/** The place being driven to; a new goal only replaces it on 안내 시작. */
let drivingTo: Place | null = null;
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
  el("go").textContent = route ? (goal === drivingTo ? "이 경로로" : "이곳으로 변경") : "안내 시작";
  el("go-sim").textContent = sim?.running ? "모의 주행 다시" : "모의 주행";
  nearby.refresh();
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

// -- 집 · 회사 · 즐겨찾기 --

let saved = loadPlaces();
/** Waiting for the next place chosen to become 집 or 회사. */
let saving: "home" | "work" | null = null;
const SAVED_NAMES = { home: "집", work: "회사" } as const;

function drawSaved() {
  el("home-sub").textContent = saved.home?.name ?? "설정하기";
  el("work-sub").textContent = saved.work?.name ?? "설정하기";
  const ul = el<HTMLUListElement>("favs");
  ul.replaceChildren();
  for (const p of saved.favourites) {
    const li = item(p.name, p.address);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "✕";
    del.title = "즐겨찾기에서 빼기";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      saved = toggleFavourite(saved, p);
      savePlaces(saved);
      drawSaved();
    });
    li.prepend(del);
    li.addEventListener("click", () => void choose(p));
    ul.append(li);
  }
  el("fav-box").hidden = saved.favourites.length === 0;
}

function startSaving(kind: "home" | "work" | null) {
  saving = kind;
  el("saving").hidden = !kind;
  const input = el<HTMLInputElement>("q");
  if (kind) {
    el("saving-text").textContent = `${SAVED_NAMES[kind]}으로 저장할 곳을 검색하세요`;
    input.placeholder = `${SAVED_NAMES[kind]} 주소나 이름`;
    input.focus();
  } else {
    input.placeholder = "어디로 갈까요?";
  }
}
el("saving-cancel").addEventListener("click", () => startSaving(null));
for (const kind of ["home", "work"] as const) {
  el(kind === "home" ? "go-home" : "go-work").addEventListener("click", () => {
    const place = saved[kind];
    if (place) void choose(place);
    else startSaving(kind);
  });
}

function setSaved(kind: "home" | "work", place: Place) {
  saved = { ...saved, [kind]: place };
  savePlaces(saved);
  drawSaved();
}

/** The ☆ on the route cards: filled when the place is 집, 회사 or a favourite; the menu says which. */
function drawSaveMenu() {
  if (!goal) return;
  const isHome = samePlace(saved.home, goal), isWork = samePlace(saved.work, goal), fav = isFavourite(saved, goal);
  el("pv-save").textContent = isHome || isWork || fav ? "★" : "☆";
  el("pv-save").classList.toggle("on", isHome || isWork || fav);
  el("save-home").textContent = isHome ? "집 ✓" : "집으로 설정";
  el("save-work").textContent = isWork ? "회사 ✓" : "회사로 설정";
  el("save-fav").textContent = fav ? "즐겨찾기에서 빼기" : "즐겨찾기에 추가";
  el("save-home").classList.toggle("on", isHome);
  el("save-work").classList.toggle("on", isWork);
  el("save-fav").classList.toggle("on", fav);
}
el("pv-save").addEventListener("click", () => {
  drawSaveMenu();
  el("save-menu").hidden = !el("save-menu").hidden;
});
el("save-home").addEventListener("click", () => { if (goal) setSaved("home", goal); drawSaveMenu(); el("save-menu").hidden = true; });
el("save-work").addEventListener("click", () => { if (goal) setSaved("work", goal); drawSaveMenu(); el("save-menu").hidden = true; });
el("save-fav").addEventListener("click", () => {
  if (!goal) return;
  saved = toggleFavourite(saved, goal);
  savePlaces(saved);
  drawSaved();
  drawSaveMenu();
  el("save-menu").hidden = true;
});
drawSaved();

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
  el("save-menu").hidden = true;
  // Chosen while 집 or 회사 was being set: that is where it is now.
  if (saving) {
    setSaved(saving, place);
    log(`${SAVED_NAMES[saving]} 저장: ${place.name}`);
    startSaving(null);
  }
  drawSaveMenu();
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
    // Back to the drive as it was, to where it was going.
    goal = drivingTo;
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
  const elsewhere = !fresh && goal !== drivingTo;
  route = r;
  chosen = r;
  drivingTo = goal;
  routeLayer.show(route);
  tracker.setRoute(route);
  sim?.follow(route);
  // What was said is kept across a re-route or a faster way to the same
  // place (the same camera, the same junction, once); a new place starts afresh.
  if (fresh || elsewhere) {
    turnsSaid.clear();
    warningsSaid.clear();
  }
  watch = new RouteWatch(route, () => ({ wants: (k) => wants(guide, k), cameraFromM: guide.cameraFromM }), warningsSaid);
  watchedAt = null;
  arrived = false;
  showScreen("drive");
  setFollow(true);
  if (goal) remember(goal);
  if (fresh) voice.say(EVENTS.start);
  else if (elsewhere) voice.say(EVENTS.changed);
  if (recheck == null) recheck = window.setInterval(() => void recheckRoute(), RECHECK_MS);
}

function endDrive() {
  if (sim?.running) stopSim();
  route = null;
  goal = null;
  drivingTo = null;
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
  goal = drivingTo;
  if (goal) {
    el("pv-name").textContent = goal.name;
    el("pv-addr").textContent = goal.address;
  }
  showScreen("preview");
  el("pv-msg").textContent = "경로 다시 찾는 중…";
  await fetchOffers();
});

/** Every few minutes on the way: a much quicker route from any provider wins. */
async function recheckRoute() {
  if (!drivingTo || !route || !gps.last || rerouting) return;
  if (!el("s-preview").hidden) return; // the cards are open; the driver is choosing
  const current = tracker.frame()?.remainingS ?? route.durationS;
  try {
    const answer = await api.routes(here(), drivingTo.at);
    const best = answer.routes.sort((a, b) => a.durationS - b.durationS)[0];
    if (best && best.durationS < current - BETTER_BY_S) {
      offers = answer.routes;
      log(`더 빠른 길: ${best.provider} ${minutes(best.durationS)} (지금 ${minutes(current)})`);
      voice.say(EVENTS.faster);
      goal = drivingTo;
      startDrive(best);
    }
  } catch (e) {
    log(`재확인 실패 ${(e as Error).message}`);
  }
}

// Off the road for three seconds: the route is asked again from here.
tracker.onOffRoute = async () => {
  if (!drivingTo || !route || rerouting) return;
  rerouting = true;
  log("경로 이탈 — 재탐색");
  voice.say(EVENTS.off);
  el("eta-left").textContent = "경로 이탈 · 재탐색 중…";
  try {
    const answer = await api.routes(here(), drivingTo.at);
    const again = answer.routes.sort((a, b) => a.durationS - b.durationS);
    const same = again.find((r) => r.provider === route!.provider) ?? again[0];
    if (same) {
      offers = again;
      goal = drivingTo;
      startDrive(same);
    }
  } catch (e) {
    log(`재탐색 실패 ${(e as Error).message}`);
  } finally {
    rerouting = false;
  }
};

/** The rungs already spoken, per guide (speech.ts decides which and when). */
const turnsSaid = new Map<string, Set<number>>();
/** The same for the road's warnings, by feature. */
const warningsSaid = new Map<string, Set<number>>();
/** A junction's key: its place to about 20 m, since each provider puts the same turn a few metres apart. */
const junction = (at: LonLat) => `${Math.round(at[0] * 5000)},${Math.round(at[1] * 5000)}`;
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
      voice.say(EVENTS.arrived);
      el("turn-icon").innerHTML = arrowSvg("arrive");
      el("turn-in").textContent = "도착";
      el("turn-text").textContent = drivingTo?.name ?? "";
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
  const key = junction(g.at);
  const said = turnsSaid.get(key) ?? new Set<number>();
  turnsSaid.set(key, said);
  const sentence = turnSpeech(maneuverOf(route.provider, g), shown.nextGuide.inM, shown.speedMps * 3.6, said, g.text);
  if (sentence && guide.turns) voice.say(sentence);
}

const km = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const minutes = (s: number) => (s < 3600 ? `${Math.round(s / 60)}분` : `${Math.floor(s / 3600)}시간 ${Math.round((s % 3600) / 60)}분`);
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const arrivalAt = (inS: number) => hhmm(new Date(Date.now() + inS * 1000));

// The clock in the corner, as every car shows one.
setInterval(() => { el("clock").textContent = hhmm(new Date()); }, 1000);
el("clock").textContent = hhmm(new Date());
drawRecents();

// ---- 주변 --------------------------------------------------------------------

const nearby = new Nearby({
  map,
  here,
  following: () => follow,
  route: () => route,
  alongM: () => tracker.frame()?.alongM ?? null,
  demo,
  log,
  go: (place) => void choose(place),
  look: (at) => {
    setFollow(false);
    touchedAt = Date.now();
    // Into the middle of the free part of the screen (an offset, not padding: see centreFor).
    const middle = carSpot(0);
    const canvas = map.getCanvas();
    map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 16), offset: [middle.x - canvas.clientWidth / 2, 0], duration: 600 });
  },
  sheet: (open) => {
    if (open) { openDock(false); el("guide").hidden = true; el("weather").hidden = true; }
    sideChanged();
  },
});
el("nearby-open").addEventListener("click", () => nearby.show(!nearby.isOpen));
setView(view);
setFollow(true);

/** The right column's holder changed: the controls step aside, and the car re-centres. */
function sideChanged() {
  const open = !el("nearby").hidden || !el("guide").hidden || !el("weather").hidden || !el("music-dock").classList.contains("closed");
  document.body.classList.toggle("side-open", open);
  el("nearby-open").classList.toggle("on", nearby.isOpen);
}

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
  showLimit(watch.limitAt(along), fix.speed);
}

/** When the soft over-the-limit chime last sounded; it repeats while over, not faster than this. */
let chimedAt = 0;
const CHIME_EVERY_MS = 3000;

/**
 * The limit ahead on the panel (a sign, and "과속 카메라 420 m" or
 * "구간 단속"), the speed in red over it, and the chime — the car apps'
 * camera stretch, as far out as the warning starts.
 */
function showLimit(held: ReturnType<RouteWatch["limitAt"]>, speedMps: number | null | undefined) {
  el("cam").hidden = !held;
  const kmh = speedMps == null ? null : speedMps * 3.6;
  const over = !!held && kmh != null && kmh > held.limit + guide.overspeedBy;
  document.querySelector(".big")!.classList.toggle("over", over);
  if (!held) return;
  el("cam-limit").textContent = String(held.limit);
  el("cam-what").textContent = held.why === "section" ? "구간 단속 중" : `단속 카메라 ${km(held.inM ?? 0)}`;
  if (over && guide.overspeed && Date.now() - chimedAt > CHIME_EVERY_MS) {
    chimedAt = Date.now();
    voice.chime();
  }
}

// ---- a finger on the map ----------------------------------------------------
// A tap on a shop's icon brings up that shop (and its neighbours) to drive
// to; holding anywhere drops a pin and offers the spot's own address. The
// ground (TMAP, NAVER) cannot say what its icons are, so Kakao is asked
// what is at the point — its places sit where those maps draw them.

const HOLD_MS = 600;
let herePin: maplibregl.Marker | null = null;
/** A hold has just shown the card: the click the browser sends after it is not a tap. */
let heldAt = 0;

function closeHere() {
  el("here-card").hidden = true;
  herePin?.remove();
  herePin = null;
}
el("here-close").addEventListener("click", closeHere);

async function showHere(at: LonLat, held: boolean) {
  let answer: Awaited<ReturnType<typeof api.here>>;
  try {
    answer = await api.here(at, held ? 60 : 25, held);
  } catch (e) {
    if (held) { el("here-title").textContent = `찾지 못함: ${(e as Error).message}`; el("here-list").replaceChildren(); el("here-card").hidden = false; }
    return;
  }
  const rows: Place[] = [];
  if (held) rows.push({ name: answer.address?.name || "이 위치", address: answer.address?.address ?? `${at[1].toFixed(5)}, ${at[0].toFixed(5)}`, at });
  for (const p of answer.places.slice(0, held ? 4 : 3)) rows.push({ name: p.name, address: [p.detail, p.address].filter(Boolean).join(" · "), at: p.at });
  // A tap on nothing in particular is only a tap.
  if (!held && rows.length === 0) return closeHere();
  el("here-title").textContent = held ? "이 위치" : "여기";
  const ul = el<HTMLUListElement>("here-list");
  ul.replaceChildren();
  for (const place of rows) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="here-words"><div class="here-name"></div><div class="here-sub"></div></div><button type="button">여기로 안내</button>`;
    li.querySelector(".here-name")!.textContent = place.name;
    li.querySelector(".here-sub")!.textContent = place.address;
    li.querySelector("button")!.addEventListener("click", () => { closeHere(); void choose(place); });
    ul.append(li);
  }
  el("here-card").hidden = false;
  herePin?.remove();
  const dot = document.createElement("div");
  dot.className = "here-pin";
  herePin = new maplibregl.Marker({ element: dot }).setLngLat(held ? at : rows[0].at).addTo(map);
}

map.on("click", (e) => {
  if (Date.now() - heldAt < 800) return;
  // The 주변 pins answer their own taps.
  if (map.getLayer("pins-dot") && map.queryRenderedFeatures(e.point, { layers: ["pins-dot", "pins-label"] }).length) return;
  void showHere([e.lngLat.lng, e.lngLat.lat], false);
});
map.on("contextmenu", (e) => {
  heldAt = Date.now();
  void showHere([e.lngLat.lng, e.lngLat.lat], true);
});
{
  // A finger held still: the browser's own long-press is not to be relied on in the car.
  let timer = 0;
  let from: { x: number; y: number } | null = null;
  const cancel = () => { clearTimeout(timer); from = null; };
  box.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return; // right-click is contextmenu
    cancel();
    const rect = box.getBoundingClientRect();
    from = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const point = from;
    timer = window.setTimeout(() => {
      heldAt = Date.now();
      const at = map.unproject([point.x, point.y]);
      void showHere([at.lng, at.lat], true);
    }, HOLD_MS);
  });
  box.addEventListener("pointermove", (e) => {
    if (!from) return;
    const rect = box.getBoundingClientRect();
    if (Math.hypot(e.clientX - rect.left - from.x, e.clientY - rect.top - from.y) > 10) cancel();
  });
  for (const kind of ["pointerup", "pointercancel"] as const) box.addEventListener(kind, cancel);
}

// ---- 안내 설정 ----------------------------------------------------------------

// ---- 날씨 --------------------------------------------------------------------

const weather = new WeatherPanel(el("wx-open"), el("weather"), el("wx-body"), log);
function openWeather(open: boolean) {
  el("weather").hidden = !open;
  if (open) {
    nearby.show(false);
    openDock(false);
    el("guide").hidden = true;
    weather.draw();
  }
  sideChanged();
}
el("wx-open").addEventListener("click", () => openWeather(el("weather").hidden));
el("wx-close").addEventListener("click", () => openWeather(false));
// Where the car is, every five minutes (the panel asks again only after 10 km or a quarter of an hour).
setInterval(() => void weather.refresh(here()), 5 * 60_000);
map.once("load", () => void weather.refresh(here()));

const guide = loadGuide();
function applyGuide() {
  voice.enabled = guide.voice;
  voice.voiceName = guide.voiceName;
  voice.setVolume(guide.volume);
}
/** A voice chosen from the list: heard at once, and its sentences made ahead on the server. */
function voicePicked(name: string | null) {
  voice.preview(EVENTS.start);
  void fetch(`/api/tts/warm${name ? `?voice=${encodeURIComponent(name)}` : ""}`).catch(() => undefined);
}
const loadVoices = async (): Promise<VoiceList> => {
  const a = await fetch("/api/tts/voices");
  if (!a.ok) throw new Error(`${a.status}`);
  return a.json();
};
applyGuide();
function openGuide(open: boolean) {
  el("guide").hidden = !open;
  if (open) {
    nearby.show(false);
    openDock(false);
    el("weather").hidden = true;
    drawGuide(el("guide-rows"), guide, applyGuide, loadVoices, voicePicked);
  }
  sideChanged();
}
el("guide-open").addEventListener("click", () => openGuide(el("guide").hidden));
el("guide-close").addEventListener("click", () => openGuide(false));

// ---- music -----------------------------------------------------------------
// The dock is a mini bar (art, title, ⏯ ⏭) that opens into the full
// player — tabs for the connected services, big art, progress, transport,
// playlists. Choosing something to play closes it again: the map is what
// the driver should be looking at.

const sources: MusicSource[] = [
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
  if (open && nearby.isOpen) nearby.show(false);
  if (open) { el("guide").hidden = true; el("weather").hidden = true; }
  sideChanged();
}
el("mini").addEventListener("click", () => {
  const opening = el("music-dock").classList.contains("closed");
  openDock(opening);
  // With a single account connected there is nothing to choose: it is connected at once.
  if (opening && !music && !demo) void drawSources().then((connected) => { if (connected.length === 1 && !music) void pickSource(connected[0]); });
});
drawDockSize();

/** The buttons for the connected accounts; answers which those are. */
async function drawSources(): Promise<MusicSource[]> {
  if (demo) return [];
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
    musicSay("연결된 음악 계정이 없습니다. /admin 에서 TIDAL 을 연결하면 여기에 나타납니다.");
  }
  return connected;
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
    if (shuffleOn) await s.shuffle?.(true).catch(() => undefined);
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

/** A playing (or paused mid-song) player keeps its bar; with nothing on, the dock shrinks to a button. */
function drawDockSize() {
  el("music-dock").classList.toggle("compact", !now.playing && !now.title);
}

/** Round, soft icons for the transport (an emoji font may be missing in the car). */
const ICONS = {
  play: `<svg viewBox="0 0 24 24" width="26" height="26"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" width="26" height="26"><rect x="6" y="5" width="4.2" height="14" rx="2" fill="currentColor"/><rect x="13.8" y="5" width="4.2" height="14" rx="2" fill="currentColor"/></svg>`,
  next: `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 6.2v11.6a.9.9 0 0 0 1.4.75L14.5 13a1.2 1.2 0 0 0 0-2L6.4 5.45A.9.9 0 0 0 5 6.2z" fill="currentColor"/><rect x="16" y="5" width="3" height="14" rx="1.5" fill="currentColor"/></svg>`,
  prev: `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M19 6.2v11.6a.9.9 0 0 1-1.4.75L9.5 13a1.2 1.2 0 0 1 0-2l8.1-5.55A.9.9 0 0 1 19 6.2z" fill="currentColor"/><rect x="5" y="5" width="3" height="14" rx="1.5" fill="currentColor"/></svg>`,
};
el("music-prev").innerHTML = ICONS.prev;
el("music-shuffle").innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h3.5c2.2 0 3.6 1.1 4.8 3l1.4 2.2c1.2 1.9 2.6 3 4.8 3H20"/><path d="M3 17h3.5c1.4 0 2.4-.4 3.3-1.2M14.2 8.2c.9-.8 1.9-1.2 3.3-1.2H20"/><path d="M17.5 4.5 20 7l-2.5 2.5M17.5 12.7 20 15.2l-2.5 2.5"/></svg>`;
el("music-next").innerHTML = ICONS.next;
el("mini-next").innerHTML = ICONS.next;

/** The cover whose colour the player wears now, so a late answer for an old cover is not applied. */
let tintFor = "";
function wearTint(art: string | undefined) {
  const dock = el("music-dock");
  if (!art) { dock.style.removeProperty("--tint"); dock.style.removeProperty("--deep"); tintFor = ""; return; }
  if (art === tintFor) return;
  tintFor = art;
  void tintOf(art).then((c) => {
    if (tintFor !== art || !c) return;
    dock.style.setProperty("--tint", pastel(c));
    dock.style.setProperty("--deep", deep(c));
  });
}

function showNow(state: NowPlaying) {
  now = state;
  nowAt = performance.now();
  drawDockSize();
  const has = !!state.title;
  el("music-dock").classList.toggle("playing", state.playing);
  el("mini-title").textContent = state.title ?? "음악";
  el("mini-artist").textContent = state.artist ?? music?.label ?? "TIDAL";
  el("now-title").textContent = state.title ?? "";
  el("now-artist").textContent = state.artist ?? "";
  for (const id of ["mini-art", "now-art"]) {
    el(id).style.backgroundImage = state.art ? `url("${state.art}")` : "";
  }
  wearTint(state.art);
  const icon = state.playing ? ICONS.pause : ICONS.play;
  el("mini-toggle").innerHTML = icon;
  el("music-toggle").innerHTML = icon;
  el("music-toggle").title = state.playing ? "일시정지" : "재생";
  el("mini-toggle").hidden = !has;
  el("mini-next").hidden = !has;
  tellMediaSession(state);
  drawProgress();
  if (state.note !== undefined || lastNote !== undefined) {
    if (state.note !== lastNote) musicSay(state.note ?? "", state.noteBad);
    lastNote = state.note;
  }
}
let lastNote: string | undefined;

/**
 * The OS's own media controls (and a keyboard's play key) in step with the
 * player: MediaSession, where the browser has it.
 */
let sessionWired = false;
function tellMediaSession(state: NowPlaying) {
  const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
  if (!ms || typeof MediaMetadata === "undefined") return;
  if (state.title) ms.metadata = new MediaMetadata({ title: state.title, artist: state.artist ?? "", artwork: state.art ? [{ src: state.art, sizes: "300x300" }] : [] });
  ms.playbackState = state.playing ? "playing" : "paused";
  if (sessionWired) return;
  sessionWired = true;
  const on = (action: MediaSessionAction, fn: () => void) => { try { ms.setActionHandler(action, fn); } catch { /* not this one */ } };
  on("play", () => void music?.toggle().catch(onMusicError));
  on("pause", () => void music?.toggle().catch(onMusicError));
  on("nexttrack", () => void music?.next().catch(onMusicError));
  on("previoustrack", () => void music?.previous().catch(onMusicError));
}

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
/** A finger on the seek bar: the bar is theirs until they let go. */
let seeking = false;

/** The bar moves between state events while the track plays. */
function drawProgress() {
  const bar = el<HTMLInputElement>("seek");
  if (now.durationS == null || now.positionS == null) {
    if (!seeking) { bar.value = "0"; bar.style.setProperty("--p", "0%"); }
    el("t-at").textContent = "0:00";
    el("t-len").textContent = now.durationS ? clock(now.durationS) : "0:00";
    return;
  }
  const elapsed = now.playing ? (performance.now() - nowAt) / 1000 : 0;
  const at = Math.min(now.durationS, now.positionS + elapsed);
  if (!seeking) {
    bar.value = String(Math.round((at / now.durationS) * 1000));
    bar.style.setProperty("--p", `${(at / now.durationS) * 100}%`);
    el("t-at").textContent = clock(at);
  }
  el("t-len").textContent = clock(now.durationS);
}
setInterval(drawProgress, 1000);
{
  const bar = el<HTMLInputElement>("seek");
  bar.addEventListener("input", () => {
    seeking = true;
    bar.style.setProperty("--p", `${Number(bar.value) / 10}%`);
    if (now.durationS) el("t-at").textContent = clock((Number(bar.value) / 1000) * now.durationS);
  });
  bar.addEventListener("change", () => {
    seeking = false;
    if (!now.durationS) return;
    const to = (Number(bar.value) / 1000) * now.durationS;
    now = { ...now, positionS: to };
    nowAt = performance.now();
    if (music?.seek) void music.seek(to).catch(onMusicError);
  });
}

/** One playlist row: its cover, its name, how many songs (or [sub], a song's artist). */
function listRow(name: string, count: number | undefined, art: string | undefined, sub?: string): HTMLLIElement {
  const li = document.createElement("li");
  li.innerHTML = `<div class="art thumb"></div><div class="li-words"><div class="li-name"></div><small></small></div>`;
  if (art) (li.querySelector(".art") as HTMLElement).style.backgroundImage = `url("${art}")`;
  li.querySelector(".li-name")!.textContent = name;
  li.querySelector("small")!.textContent = sub ?? (count != null ? `${count}곡` : "");
  li.dataset.name = name;
  return li;
}

const filterLists = debounce(() => {
  const q = el<HTMLInputElement>("list-filter").value;
  for (const li of el("music-lists").querySelectorAll<HTMLLIElement>("li")) li.hidden = !matches(li.dataset.name ?? "", q);
}, 250);
/** The service's own search, a little after the typing stops; what it finds sits above the lists. */
let searchRun = 0;
const searchService = debounce(async () => {
  const q = el<HTMLInputElement>("list-filter").value.trim();
  const found = el<HTMLUListElement>("music-found");
  const run = ++searchRun;
  if (!music?.search || q.length < 2) { found.hidden = true; found.replaceChildren(); return; }
  try {
    const hits = await music.search(q);
    if (run !== searchRun) return;
    drawRows(found, hits);
    found.hidden = hits.length === 0;
    if (hits.length === 0) musicSay(`"${q}" 에 맞는 곡이 없습니다`);
    else musicSay("");
  } catch (e) {
    if (run === searchRun) musicSay((e as Error).message, true);
  }
}, 600);
el("list-filter").addEventListener("input", () => { filterLists(); void searchService(); });

/** Rows into [ul], with a heading wherever the shelf changes; a tap plays the row. */
function drawRows(ul: HTMLUListElement, lists: Playlist[]) {
  ul.replaceChildren();
  let shelf: string | undefined;
  for (const p of lists) {
    if (p.group && p.group !== shelf) {
      shelf = p.group;
      const h = document.createElement("li");
      h.className = "shelf";
      h.textContent = p.group;
      h.dataset.name = "";
      ul.append(h);
    }
    const li = listRow(p.name, p.count, p.art, p.sub);
    li.addEventListener("click", async () => {
      try {
        musicSay("");
        lastNote = undefined; // the service's word (a preview) is said again for the new song
        await music!.play(p.uri);
        openDock(false);
      } catch (e) {
        musicSay((e as Error).message, true);
      }
    });
    ul.append(li);
  }
}

async function showLists() {
  if (!music) return;
  const ul = el<HTMLUListElement>("music-lists");
  ul.replaceChildren();
  el("music-found").hidden = true;
  const filter = el<HTMLInputElement>("list-filter");
  filter.value = "";
  filter.placeholder = music.search ? `${music.label} 에서 곡·재생목록 찾기` : "플레이리스트 찾기 (초성도 돼요)";
  filter.hidden = !music.search;
  try {
    const lists = await music.playlists();
    drawRows(ul, lists);
    ul.hidden = lists.length === 0;
    filter.hidden = !music.search && lists.length < 6;
    if (lists.length === 0) musicSay(`${music.label}: 재생목록이 없습니다`);
  } catch (e) {
    musicSay((e as Error).message, true);
  }
}

const onMusicError = (e: Error) => musicSay(e.message, true);
// 셔플: remembered across drives, and told to whichever service is playing.
let shuffleOn = (() => { try { return localStorage.getItem("music-shuffle") === "1"; } catch { return false; } })();
function drawShuffle() {
  el("music-shuffle").classList.toggle("on", shuffleOn);
  el("music-shuffle").setAttribute("aria-pressed", String(shuffleOn));
}
drawShuffle();
el("music-shuffle").addEventListener("click", () => {
  shuffleOn = !shuffleOn;
  try { localStorage.setItem("music-shuffle", shuffleOn ? "1" : "0"); } catch { /* not kept */ }
  drawShuffle();
  void music?.shuffle?.(shuffleOn).catch(onMusicError);
});
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
  sim.onEnd = () => { el("sim-toggle").classList.remove("on"); el("sim-bar").hidden = true; log("모의 주행 끝"); };
  sim.start();
  el("sim-toggle").classList.add("on");
  el("sim-bar").hidden = false;
  el("sim-kmh").textContent = el<HTMLInputElement>("sim-speed").value;
  log(`모의 주행 시작 ${Math.round(sim.speedMps * 3.6)} km/h`);
}
function stopSim() {
  sim?.stop();
  el("sim-toggle").classList.remove("on");
  el("sim-bar").hidden = true;
  gps.start();
}
// 모의 주행 from the route cards, as the car apps have it: the chosen way,
// driven by a pretend GPS, with the voice and the warnings as for real.
el("go-sim").addEventListener("click", () => {
  if (!chosen) return;
  startDrive(chosen);
  startSim();
});
for (const [id, by] of [["sim-slower", -10], ["sim-faster", 10]] as const) {
  el(id).addEventListener("click", () => {
    const input = el<HTMLInputElement>("sim-speed");
    input.value = String(Math.max(10, Math.min(120, Number(input.value) + by)));
    input.dispatchEvent(new Event("input"));
    el("sim-kmh").textContent = input.value;
  });
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
    // A made-up camera a quarter of the way along, limit 30 against the
    // pretend 50 km/h, so the sign, the red speed and the chime can be seen.
    const cam = path[q(0.25)];
    watch?.add([{ id: "demo:cam", kind: "speed", lon: cam[0], lat: cam[1], limit: 30 }]);
    startSim();
  }
  const row = el("music-sources");
  for (const [name, on] of [["TIDAL", true]] as const) {
    const b = document.createElement("button");
    b.textContent = name;
    b.classList.toggle("on", on);
    row.append(b);
  }
  el("player").hidden = false;
  showNow({ playing: true, title: "Blue in Green", artist: "Miles Davis", positionS: 97, durationS: 337, art: demoCover(262, 330) });
  const lists = el("music-lists");
  for (const [name, n, h1, h2] of [["드라이브 플레이리스트", 48, 200, 160], ["Jazz at Night", 120, 250, 290], ["Daily Mix 1", 50, 20, 340], ["출근길 신나는 노래", 64, 45, 10], ["잔잔한 새벽", 32, 190, 230], ["Lo-fi Beats", 88, 280, 200]] as const) {
    lists.append(listRow(name, n, demoCover(h1, h2)));
  }
  lists.hidden = false;
  el("list-filter").hidden = false;
  if (new URLSearchParams(location.search).get("dock") === "open") openDock(true);
  setFollow(true);
});

/** A made-up cover for the demo: a soft two-colour wash with a little record on it. */
function demoCover(h1: number, h2: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1},80%,72%)"/><stop offset="1" stop-color="hsl(${h2},75%,62%)"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><circle cx="210" cy="95" r="46" fill="rgba(255,255,255,.35)"/><circle cx="110" cy="190" r="70" fill="rgba(20,20,30,.55)"/><circle cx="110" cy="190" r="22" fill="hsl(${h1},80%,80%)"/><circle cx="110" cy="190" r="5" fill="#15151c"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ?debug: a handle for scripted checks at a desk — what the voice said and
// when, the music's level, the route and the watch. Nothing in the page
// uses it; without ?debug it is not there.
if (new URLSearchParams(location.search).has("debug")) {
  const said: { t: number; text: string }[] = [];
  const say = voice.say.bind(voice);
  voice.say = (text: string) => {
    // Where the next turn was when this was said, to tell one junction said twice from two junctions.
    const next = tracker.frame()?.nextGuide;
    said.push({ t: Date.now(), text, guide: next ? `${junction(next.guide.at)} in ${Math.round(next.inM)}m` : "" } as { t: number; text: string });
    say(text);
  };
  (window as unknown as { nav: unknown }).nav = {
    said, voice, tracker, gps, map,
    get route() { return route; },
    get watch() { return watch; },
    get sim() { return sim; },
    recheck: () => recheckRoute(),
  };
}

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
    nearby.sources = health.nearby;
    if (!health.search) el<HTMLInputElement>("q").placeholder = "검색 키 없음 — lon,lat 입력";
  } catch {
    log("서버 응답 없음 (/api/health)");
  }
});
