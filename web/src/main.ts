import maplibregl from "maplibre-gl";
import { api, setHeading } from "./api";
import { Gps, type Fix } from "./gps";
import { chime, keepAwake } from "./probes";
import { Replay } from "./replay";
import { Simulator } from "./simulate";
import { RouteLayer } from "./route-layer";
import { OFF_M, Tracker, type Shown } from "./tracker";
import { Line, bearing, lerpAngle, metres } from "./geo";
import { arrowSvg, fromBend, maneuverOf, shapedOf, type Bend, type Maneuver } from "./maneuver";
import { lazy, type MusicSource, type NowPlaying, type Playlist } from "./music/source";
import { debounce, matches } from "./music/find";
import { deep, pastel, tintOf } from "./music/tint";
import { Voice } from "./voice";
import { RouteWatch, phraseFor, type Ahead, type Feature, type Kind } from "./warnings";
import { Notes, incidentNote, popupNote, restNote, schoolNote, type Note } from "./notes";
import { CameraLayer } from "./camera-layer";
import { loadDrive, loadLast, saveDrive, saveLast, worthResuming } from "./resume";
import { applyTheme } from "./theme";
import { HdLayer } from "./hdmap-layer";
import { ZoneLayer } from "./zone-layer";
import { drawLaneCard, onlyWords, type GuideColour, type Junction as JunctionView, type LaneCard, type Lanes, type Turn as LaneTurn } from "./lanes-strip";
import { GUIDE_LINES } from "../../server/src/phrases";
import { ALERT_KINDS, alertPhrase, type AlertKind } from "../../server/src/phrases";
import { Nearby } from "./nearby";
import { autoZoom } from "./autozoom";
import { EVENTS, turnSay } from "./speech";
import { junctionOf, laneHint, motorwayAt, namedTurnPhrase } from "./highway";
import { CLOSEUP_CAR_AT, CLOSEUP_PITCH, CloseupHold, zoomToSee, type Closeup } from "./closeup";
import { RerouteBackoff } from "./reroute-backoff";
import { Stillness } from "./still";
import { TURN_NEAR_M, fasterPhrase, turnPhrase, warningPhrase, type Turn } from "../../server/src/phrases";
import { drawGuide, loadGuide, shows, wants, type VoiceList } from "./guide-settings";
import { currentUser, logout, push as pushUserData } from "./userdata";
import { WeatherPanel } from "./weather";
import { isFavourite, loadPlaces, samePlace, savePlaces, toggleFavourite } from "./places";
import { OVERLAY_STYLE, TmapBase, tmapAvailable } from "./tmap-base";
import { NightCity } from "./night-city";
import { CHECK, X } from "./icons";
import { snapRoute } from "./thread";
import type { Guide, Health, LonLat, Place, Provider, Route } from "./types";

// The ground: TMAP's or NAVER's own vector map when the server has their
// keys (Korean roads as they know them: tmap-base.ts, naver-base.ts), else
// a key-free OpenStreetMap style — or any style URL through VITE_MAP_STYLE.
// The 지도 button goes round the ones that are there.
// 지도 해상도 "빠르게": both maps (TMAP's under, MapLibre's over) draw at one pixel per CSS pixel — a quarter of
// the work on a 2× screen, for a car computer that cannot keep up. Read before either map is made; a change asks
// for a reload (the maps size their canvases once).
const dprMode = loadGuide().mapDpr;
const realDpr = window.devicePixelRatio || 1;
/** The pixels per CSS pixel both maps draw at: as the screen is, 1.5 at most, or 1. */
const mapPixelRatio = dprMode === "fast" ? 1 : dprMode === "balanced" ? Math.min(realDpr, 1.5) : Math.min(realDpr, 2);
if (mapPixelRatio !== realDpr) {
  // TMAP's map reads window.devicePixelRatio itself; MapLibre takes pixelRatio below.
  try { Object.defineProperty(window, "devicePixelRatio", { get: () => mapPixelRatio, configurable: true }); } catch { /* read-only here: TMAP draws sharp */ }
}
// 빠르게: the blur behind every panel goes too (style.css) — a blur over a ground that redraws each frame is GPU work each frame.
document.body.classList.toggle("fast", dprMode === "fast");
const HOME: LonLat = [127.0276, 37.4979];
/** ?demo: a made-up trip fills the panel, for judging the layout at a desk. */
const demo = new URLSearchParams(location.search).has("demo");
// The 진단 panel (sound test, GPS log, pretend drive) is for checking the
// car and the desk, not for driving: shown with ?debug, or in the demo.
if (!demo && !new URLSearchParams(location.search).has("debug")) document.getElementById("diag")!.hidden = true;
const OSM_STYLE: string = import.meta.env.VITE_MAP_STYLE ?? "https://tiles.openfreemap.org/styles/liberty";
// TMAP is the ground; OSM only stands in where there is no TMAP key (a desk). NAVER's map was a ground too, but
// it is flat under tilt (no buildings) and the owner found it not worth having; the picker is for ?debug now.
type Base = "tmap" | "osm";
const BASE_ORDER: Base[] = ["tmap", "osm"];
const BASE_NAMES: Record<Base, string> = { tmap: "티맵", osm: "OSM" };
const baseReady = (b: Base) => (b === "tmap" ? tmapAvailable() : true);
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
const NAMES: Record<Provider, string> = { tmap: "티맵", kakao: "카카오", naver: "네이버", osrm: "OSM", korea: "자체" };
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
    // Where the car last was, before the first fix comes (resume.ts), else the default.
    // fadeDuration 0: no label cross-fade on every move (a cost each frame while following); no world copies to draw.
    // antialias: the multisampled canvas takes the stair-steps off the lines and the lanes in the tilted view; off in
    // 빠르게, where the pixels are already few.
    const m = new maplibregl.Map({
      container: "map", style, center: loadLast() ?? HOME, zoom: 15, pitch: 45, attributionControl: false,
      fadeDuration: 0, renderWorldCopies: false, pitchWithRotate: false, pixelRatio: mapPixelRatio, canvasContextAttributes: { antialias: dprMode !== "fast" },
    });
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
    // No zoom on a double tap: in a car a second tap lands by mistake, and the map leaping under the buttons made the
    // right-hand column seem to vanish. A pinch and the ± buttons zoom.
    m.doubleClickZoom.disable();
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
/** Lines not yet sent to the server (안내 설정 → 진단 기록 보내기), so a drive's log can be read afterwards. */
const unsent: string[] = [];
function log(text: string) {
  const line = `${new Date().toLocaleTimeString("ko-KR", { hour12: false })} ${text}`;
  lines.push(line);
  unsent.push(`${new Date().toISOString()} ${text}`);
  if (unsent.length > 2000) unsent.shift();
  if (lines.length > 200) lines.shift();
  // Written to the page only while the 진단 panel is open: two hundred lines re-set on every message otherwise cost a
  // layout each, for a box no one was looking at. Opening the panel draws what came meanwhile.
  const diag = el<HTMLDetailsElement>("diag");
  if (diag && !diag.hidden && diag.open) drawLog();
}
function drawLog() {
  const box = el("log");
  box.textContent = lines.join("\n");
  box.scrollTop = box.scrollHeight;
}
el<HTMLDetailsElement>("diag").addEventListener("toggle", () => { if (el<HTMLDetailsElement>("diag").open) drawLog(); });

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

type View = "3d" | "heading";
// Zoom follows the speed (autozoom.ts); each view only shifts it — flat
// views a little further out, since they show no road beyond the top edge.
const VIEWS: Record<View, { pitch: number; zoomShift: number; label: string; /** Share of the height pushed above the car. */ carLow: number }> = {
  "3d": { pitch: 55, zoomShift: 0, label: "3D", carLow: 0.4 },
  heading: { pitch: 0, zoomShift: -0.4, label: "2D", carLow: 0.28 },
};
const ORDER: View[] = ["3d", "heading"];
/** Left alone this long after a hand moved it, the map goes back to the car. */
const RETURN_MS = 5_000;
let view: View = (() => {
  // "north" (a north-up flat map) was a view once; a browser that kept it gets the flat one.
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
voice.onSaid = (text, playedS, lengthS, waitedS) => {
  // Short of its length means the browser stopped it (another app took the audio, the page went to the back).
  if (playedS < lengthS - 0.2) log(`음성 끊김 ${playedS.toFixed(1)}/${lengthS.toFixed(1)}s ${text}`);
  if (waitedS > 3) log(`음성 늦음 ${waitedS.toFixed(1)}s 기다림 ${text}`);
};
voice.onLate = (text, waitedS) => log(`음성 지남 ${waitedS.toFixed(1)}s 뒤라 버림 ${text}`);
voice.onError = (m) => {
  el("voice").textContent = "실패";
  log(`음성 실패 ${m}`);
};
/** The browser's last refusal: 1 is a permission denied (or an insecure page), which will not mend itself. */
let gpsRefused: number | null = null;
gps.onError = (m) => {
  log(`GPS 오류 ${m}`);
  const code = Number(m.split(":")[0]);
  if (code === 1) gpsRefused = 1;
};
/** A fix older than this and the car is not being tracked: the line under the speed says so. */
const GPS_STALE_MS = 15_000;
function gpsState(): string | null {
  const last = gps.last;
  // Fixes coming (the browser's, a replay's or the pretend drive's): nothing to warn of.
  if (last && Date.now() - last.t <= GPS_STALE_MS) return null;
  if (!window.isSecureContext) return "https 주소가 아니라 위치를 받을 수 없습니다 — Cloudflare 주소로 여세요";
  if (gpsRefused === 1) return "위치 권한이 꺼져 있습니다 — 브라우저 설정에서 허용하세요";
  if (!last) return "위치를 찾는 중…";
  if (Date.now() - last.t > GPS_STALE_MS) return `위치 신호 없음 (${Math.round((Date.now() - last.t) / 1000)}초 전)`;
  return null;
}
setInterval(() => {
  const state = gpsState();
  const line = el("gps-warn");
  line.hidden = state == null;
  if (state) line.textContent = state;
}, 1000);
gps.on(onFix);
// Routes asked on the move start on the carriageway the car is on (Kakao and TMAP take the heading).
setHeading(() => {
  const f = gps.last;
  if (!f || f.course == null || !(f.speed != null && f.speed > 2) || Date.now() - f.t > 10_000) return null;
  return { deg: f.course, kmh: f.speed * 3.6 };
});

function onFix(fix: Fix) {
  tracker.feed(fix);
  stillness.feed([fix.lon, fix.lat], fix.speed);
  if (!sim?.running) saveLast([fix.lon, fix.lat]);
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
/** What the frame loop has already complained of, by message: once each, not sixty times a second. */
const frameErrors = new Set<string>();
/** When the camera last moved, for the 30 fps setting: a frame sooner than its share is drawn without moving the map. */
let cameraMovedAt = 0;
function frame() {
  try {
    const shown = tracker.frame();
    if (shown) {
      marker.setLngLat(shown.at);
      put("mode", MODES[shown.mode] + (shown.offM != null ? ` · ${Math.round(shown.offM)} m` : ""));
      marker.setRotation(shown.bearing);
      zoomSpeed += (shown.speedMps * 3.6 - zoomSpeed) * 0.03;
      turnInM = route ? shown.nextGuide?.inM : undefined;
      closeup = closeupFor(shown);
      showCloseup(closeup);
      // 카메라 프레임 30: the map moved every other frame — a car computer that cannot keep 60 draws an even 30 more
      // smoothly than an uneven 40 — the car itself still drawn every frame.
      const now = performance.now();
      const due = guide.followFps !== 30 || now - cameraMovedAt >= 1000 / 30 - 2;
      if (follow && !handsOn() && due) { followCar(shown.at, shown.speedMps); cameraMovedAt = now; }
      // The painted lanes only where they matter on the move — near a turn, or slow — unless asked for always; a map
      // moved by hand shows everything.
      hdLayer?.setAway(guide.hdLanesWhen === "turns" && follow && !handsOn() && lanesAway(shown));
      showTurn(shown);
      showLanes(shown);
      backoff.seen(!shown.offRoute && (shown.offM == null || shown.offM <= OFF_M));
    }
  } catch (e) {
    // One bad frame (a NaN handed to the marker) must not end the loop for the rest of the drive.
    const message = (e as Error)?.message ?? String(e);
    if (!frameErrors.has(message)) {
      frameErrors.add(message);
      log(`화면 갱신 오류 ${message}`);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const approach = (from: number, to: number, k: number) => (Math.abs(to - from) < 0.005 ? to : from + (to - from) * k);

/** Whether the painted lanes can be put away for now: driving on at speed with no turn within reach (with a little play, so they do not flicker). */
let lanesWereAway = false;
function lanesAway(shown: Shown): boolean {
  const kmh = shown.speedMps * 3.6;
  const turnNear = shown.nextGuide != null && shown.nextGuide.inM < LANES_TURN_M;
  const fast = kmh > (lanesWereAway ? LANES_SLOW_KMH - 5 : LANES_SLOW_KMH + 5);
  lanesWereAway = fast && !turnNear;
  return lanesWereAway;
}
const LANES_TURN_M = 400;
const LANES_SLOW_KMH = 30;

/** When the camera last followed, so its easing goes by time, not by frames. */
let followedAt = 0;

/** One frame of following: everything eases toward where it should be. */
function followCar(at: LonLat, speedMps = 0) {
  const v = VIEWS[view];
  // The easing shares below are per frame at 60 fps. A slower browser (the car's, a busy one) draws fewer
  // frames, and at the same shares took seconds to find the car after 안내 시작: scaled here to the time
  // since the last frame, the glide takes as long at any frame rate. A long gap (not following) is one frame.
  const now = performance.now();
  const gap = now - followedAt;
  followedAt = now;
  const frames = gap > 1000 ? 1 : Math.min(gap, 250) / (1000 / 60);
  const k = (share: number) => 1 - Math.pow(1 - share, frames);
  // Close up on a junction: the car low on the screen, tilted, drawn back to see the fork (closeup.ts).
  const close = !!closeup;
  let want = close ? { x: carSpot(0).x, y: layout.height * CLOSEUP_CAR_AT } : carSpot(v.carLow);
  // The lane card at the top of the map: the car kept clear below it.
  if (layout.lanesBottom > 0) want = { x: want.x, y: Math.max(want.y, layout.lanesBottom + CAR_BELOW_CARD_PX) };
  spot = spot ? { x: approach(spot.x, want.x, k(0.08)), y: approach(spot.y, want.y, k(0.08)) } : want;
  const before = map.getCenter();
  const zoomTo = close ? zoomToSee(Math.max(0, closeup!.inM), at[1], layout.height * (CLOSEUP_CAR_AT - 0.12)) : Math.max(10, Math.min(20, speedZoom() + zoomBias));
  const camera = {
    bearing: tracker.cameraBearing(map.getBearing(), k(0.18)),
    pitch: approach(map.getPitch(), close ? CLOSEUP_PITCH : v.pitch, k(close ? 0.08 : 0.12)),
    // Quick when coming back to the car; smooth as the speed changes, like a drive.
    zoom: approach(map.getZoom(), zoomTo, k(returning ? 0.14 : close ? 0.06 : 0.04)),
  };
  let center = centreFor(at, spot, camera);
  if (returning) {
    const eased: LonLat = [before.lng + (center[0] - before.lng) * k(0.15), before.lat + (center[1] - before.lat) * k(0.15)];
    if (metres(eased[0], eased[1], center[0], center[1]) < 1) returning = false;
    center = eased;
  } else {
    // Harmonized cushion on the centre: follows smoothly without letting the car swing off spot during turns.
    center = [before.lng + (center[0] - before.lng) * k(0.28), before.lat + (center[1] - before.lat) * k(0.28)];
  }
  // Standing still with the camera settled: nothing to move, so no move.
  // When moving (even crawling under 5 km/h in traffic), always update to keep the glide continuous without micro-stutters.
  const moving = speedMps > 0.2 || returning;
  if (!moving && metres(before.lng, before.lat, center[0], center[1]) < 0.01 && Math.abs(map.getZoom() - camera.zoom) < 0.0005
    && Math.abs(lerpAngle(map.getBearing(), camera.bearing, 1) - map.getBearing()) < 0.02 && Math.abs(map.getPitch() - camera.pitch) < 0.02) return;
  map.jumpTo({ center, ...camera });
}

/**
 * The camera centre that puts [at] at screen point [to]. This is what
 * padding would do, but TMAP's camera takes no padding, so both maps keep
 * a plain centre and the car is placed by moving it: aim at the car, slide
 * by the offset, then once more for the tilt's perspective.
 */
function centreFor(at: LonLat, to: { x: number; y: number }, camera: { bearing: number; pitch: number; zoom: number }): LonLat {
  // On a copy of the map's transform: three jumpTo a frame moved the map (and the TMAP ground under it) three times a frame.
  const t = map.transform.clone();
  t.setZoom(camera.zoom);
  t.setBearing(camera.bearing);
  t.setPitch(camera.pitch);
  t.setCenter(new maplibregl.LngLat(at[0], at[1]));
  const cx = t.width / 2, cy = t.height / 2;
  let q = t.screenPointToLocation(new maplibregl.Point(2 * cx - to.x, 2 * cy - to.y));
  t.setCenter(q);
  const p = t.locationToScreenPoint(new maplibregl.LngLat(at[0], at[1]));
  q = t.screenPointToLocation(new maplibregl.Point(cx + p.x - to.x, cy + p.y - to.y));
  return [q.lng, q.lat];
}

/** The middle of the map's free part — right of the trip panel, left of whatever holds the right side — lowered by [carLow]. */
/** How far below the lane card at the top of the map the car is kept. */
const CAR_BELOW_CARD_PX = 90;

/** The junction shown close up now, or null: closeup.ts holds it a little past the junction, and a new route resets it (prepareHighway). */
let closeup: Closeup | null = null;
const closeupHold = new CloseupHold({
  motorway: (g) => onMotorway.get(g) ?? false,
  maneuver: (g) => maneuverFor(g),
  label: (g) => {
    const j = junctionOf(g);
    return ["분기점", j?.name, j?.toward && `${j.toward} 방면`].filter(Boolean).join(" · ");
  },
});
function closeupFor(shown: Shown): Closeup | null {
  if (!route || !guide.closeups) return null;
  return closeupHold.frame(shown.alongM, shown.nextGuide);
}
function showCloseup(_c: Closeup | null) {
  // The junction's name and way are on the picture at the foot of the map now (junctionFor); no chip up top.
  const c = el("closeup");
  if (!c.hidden) c.hidden = true;
}

/**
 * The screen's layout as the frame loop needs it — the panel's right edge, the destination window's, the lane
 * card's bottom, the canvas — measured when something changes size (a ResizeObserver), not sixty times a second:
 * reading a box mid-frame after the frame's own writes makes the browser lay the page out again there and then.
 */
const layout = { hudRight: 0, destRight: 0, lanesBottom: 0, width: 0, height: 0 };
function measure() {
  const canvas = map.getCanvas().getBoundingClientRect();
  layout.width = canvas.width;
  layout.height = canvas.height;
  layout.hudRight = el("hud").getBoundingClientRect().right;
  const dest = el("dest-panel");
  layout.destRight = dest.hidden ? 0 : dest.getBoundingClientRect().right;
  const card = el("lanes");
  layout.lanesBottom = card.hidden ? 0 : card.getBoundingClientRect().bottom - canvas.top;
}
const measuring = new ResizeObserver(measure);
for (const id of ["hud", "dest-panel", "lanes", "map"]) measuring.observe(el(id));
// Once now as well: the observer's first report comes after the first frame's layout, and a frame before it would
// place the car by a canvas of no size.
measure();
let nearbyEl: HTMLElement | null = null, guideEl: HTMLElement | null = null, weatherEl: HTMLElement | null = null, musicDockEl: HTMLElement | null = null;
function carSpot(carLow = 0) {
  // The free part of the map: right of the top-left card, and of the destination window when it is up.
  const left = Math.max(layout.hudRight, layout.destRight);
  nearbyEl ??= el("nearby");
  guideEl ??= el("guide");
  weatherEl ??= el("weather");
  musicDockEl ??= el("music-dock");
  const side = !nearbyEl.hidden || !guideEl.hidden || !weatherEl.hidden || !musicDockEl.classList.contains("closed");
  const right = layout.width - (side ? 356 : 76);
  return { x: (left + right) / 2, y: (layout.height * (1 + carLow)) / 2 };
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
box.addEventListener("pointerdown", (e) => { hands.add(e.pointerId); touchedAt = Date.now(); }, { capture: true, passive: true });
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
  }, { capture: true, passive: true });
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
  el("view-ic").style.transform = view === "3d" ? "perspective(40px) rotateX(28deg)" : "";
  el("view-mode").classList.toggle("on", view === "3d");
  zoomBias = 0;
  nightCity?.refresh();
  showBuildings();
  // Following, the frame eases there; off the car, the map turns on the spot.
  if (!follow) map.easeTo({ pitch: v.pitch, bearing: map.getBearing(), duration: 500 });
}
/** 야경: the buildings lit by night in the tilted view (night-city.ts); made with the other layers below. */
let nightCity: NightCity | null = null;
/** Standing buildings are for the tilted view; flat, they only cost frames. Lit ones by night take their place. */
function showBuildings() {
  try {
    const standing = view === "3d" && !nightCity?.showing;
    if (map.getLayer("building-3d")) map.setLayoutProperty("building-3d", "visibility", standing ? "visible" : "none");
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

let ground: TmapBase | null = null;
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
  } catch (e) {
    log(`${BASE_NAMES[base]} 지도 실패 ${(e as Error).message} — OSM 으로`);
    return setBase("osm", false);
  }
  el("base-label").textContent = BASE_NAMES[base];
  el("osm-credit").hidden = base !== "osm";
  drawBaseMenu();
  // The lit buildings are for a dark ground: on and off with the ground.
  nightCity?.refresh();
  showBuildings();
}

/** What each ground is, and why one cannot be chosen right now. */
function baseNote(b: Base): string {
  if (b === "osm") return "오픈스트리트맵 · 키 없이 · 한국 골목은 빠지기도";
  if (baseReady(b)) return "티맵 도로망 · 혼잡도와 같은 데이터";
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
    button.querySelector("b")!.innerHTML = BASE_NAMES[b] + (b === base ? ` ${CHECK}` : "");
    button.querySelector("small")!.textContent = baseNote(b);
    button.addEventListener("click", () => {
      el("base-menu").hidden = true;
      if (b !== base) setBase(b);
    });
    box.append(button);
  }
}
// The ground picker only at a desk (?debug): in the car the ground is TMAP, full stop.
el("base-mode").hidden = !new URLSearchParams(location.search).has("debug");
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
setBase(base, false);
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

/**
 * Where to, and the ways there, in a window rising from the 목적지 button at
 * the bottom left (like a start menu); the panel at the top left keeps to
 * the speed, the clock and, driving, the drive.
 */
let searchOpen = false;
for (const id of ["s-search", "s-preview", "diag"]) el("dest-panel").append(el(id));
function layoutPanels() {
  const open = (currentScreen === "search" && searchOpen) || currentScreen === "preview";
  el("dest-panel").hidden = !open;
  document.body.classList.toggle("hud-min", currentScreen !== "drive");
  document.body.classList.toggle("dest-open", open);
}
function openSearch(open: boolean) {
  searchOpen = open;
  layoutPanels();
  if (open) el<HTMLInputElement>("q").focus();
}
// The 목적지 button hugs the trip panel's actual right edge: narrow before a route (the speed and the clock), and
// pushed along as the panel grows with a notice or a drive. --hud-edge is in the panel's own layout pixels, as the
// button's left is (both are zoomed alike by --ui).
const hudEdge = () => document.documentElement.style.setProperty("--hud-edge", `${el("hud").offsetLeft + el("hud").offsetWidth}px`);
new ResizeObserver(hudEdge).observe(el("hud"));
hudEdge();
el("dest-open").addEventListener("click", () => openSearch(true));
el("dest-close").addEventListener("click", () => openSearch(false));
let currentScreen: Screen = "search";

function showScreen(name: Screen) {
  currentScreen = name;
  if (name !== "search") searchOpen = false;
  layoutPanels();
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

/** The last few places driven to, kept in the browser and for the user on the server. */
function recents(): Place[] {
  try { return JSON.parse(localStorage.getItem("nav-recent") ?? "[]"); } catch { return []; }
}
function remember(place: Place) {
  const kept = [place, ...recents().filter((p) => p.name !== place.name)].slice(0, 6);
  try { localStorage.setItem("nav-recent", JSON.stringify(kept)); } catch { /* private window */ }
  pushUserData("recents", kept);
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
    del.innerHTML = X;
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
  el("save-home").innerHTML = isHome ? `집 ${CHECK}` : "집으로 설정";
  el("save-work").innerHTML = isWork ? `회사 ${CHECK}` : "회사로 설정";
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
  el("offers").replaceChildren();
  offers = [];
  chosen = null;
  routeLayer.show(null);
  showScreen("preview");
  // First the place itself, close up with a pin, to see it is the one meant; the ways come on 경로 찾기.
  showDestination(place);
  el("pv-msg").textContent = "지도에서 위치를 확인하고 경로를 찾으세요";
  el("pv-find").hidden = false;
  el("go-row").hidden = true;
}

/** The place being gone to, as a pin; kept through the drive, gone when it ends. */
let destPin: maplibregl.Marker | null = null;
function showDestination(place: Place) {
  destPin?.remove();
  const dot = document.createElement("div");
  dot.className = "dest-pin";
  destPin = new maplibregl.Marker({ element: dot, anchor: "bottom" }).setLngLat(place.at).addTo(map);
  setFollow(false);
  touchedAt = Date.now();
  // Into the free part of the screen, beside the panel (an offset, as for the 주변 places).
  const middle = carSpot(0);
  map.easeTo({ center: place.at, zoom: 16.5, pitch: 0, bearing: 0, offset: [middle.x - map.getCanvas().clientWidth / 2, 0], duration: 900 });
}

el("pv-find").addEventListener("click", async () => {
  el("pv-find").hidden = true;
  el("pv-msg").textContent = "경로 찾는 중…";
  if (await fetchOffers()) el("go-row").hidden = false;
  else el("pv-find").hidden = false;
});

async function fetchOffers(): Promise<boolean> {
  if (!goal) return false;
  try {
    const answer = await api.routes(here(), goal.at);
    for (const e of answer.errors) log(`경로 실패 ${e}`);
    if (answer.routes.length === 0) throw new Error(answer.errors.join("; ") || "경로 없음");
    offers = answer.routes.sort((a, b) => a.durationS - b.durationS);
    // Keep the driven provider if it answered again, else the quickest.
    chosen = offers.find((r) => r.provider === (chosen ?? route)?.provider) ?? offers[0];
    // Without a fix the ways start from the map's middle, and say so.
    el("pv-msg").textContent = gps.last ? "" : "현위치를 모릅니다 — 지도 가운데에서 출발하는 경로입니다";
    drawOffers();
    routeLayer.show(chosen, offers);
    laneLine(chosen);
    setFollow(false);
    routeLayer.fit(...offers);
    log(`경로 ${offers.map((r) => `${r.provider} ${minutes(r.durationS)}`).join(", ")}`);
    // Our own route held back until this area's live speeds are in the router (half a minute): asked again then.
    if (answer.pending?.includes("korea")) koreaLater(goal);
    return true;
  } catch (e) {
    el("pv-msg").textContent = `경로 실패: ${(e as Error).message}`;
    return false;
  }
}

/** How long the area's speeds take to reach the router after a lookup: a fetch, the file, osrm-customize. */
const KOREA_LATER_MS = 35_000;
/**
 * Our own route for [to], asked once the live speeds have had time to land, and slipped in among the cards
 * if they are still open for the same place and the route carries live speeds now.
 */
function koreaLater(to: Place) {
  setTimeout(async () => {
    if (el("s-preview").hidden || goal !== to || offers.some((r) => r.provider === "korea")) return;
    try {
      const r = await api.route("korea", here(), to.at);
      if (el("s-preview").hidden || goal !== to || !r.segments.some((s) => s.congestion > 0)) return;
      offers = [...offers, r].sort((a, b) => a.durationS - b.durationS);
      drawOffers();
      routeLayer.show(chosen, offers);
      log(`자체 경로 추가: ${minutes(r.durationS)}`);
    } catch (e) {
      log(`자체 경로 실패 ${(e as Error).message}`);
    }
  }, KOREA_LATER_MS);
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
      `<div class="l2">${km(r.distanceM)} · ${NAMES[r.provider]}${r.segments.some((s) => s.congestion > 0) ? "" : " (교통 정보 없음)"}</div>` +
      `<div class="bar">${trafficBar(r)}</div>`;
    li.addEventListener("click", () => {
      chosen = r;
      drawOffers();
      routeLayer.show(chosen, offers);
      laneLine(chosen);
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
    destPin?.remove();
    destPin = null;
    showScreen("search");
    setFollow(true);
  }
});

// -- 3. on the way --

/**
 * The route's line moved (onto the lanes, a few metres sideways, the same
 * vertices): only what holds the line is set again — drawn, matched
 * against, the pretend drive kept at its place on it, the lanes' line.
 * Nothing said or held about the drive is touched.
 */
function relined(r: Route) {
  routeLayer.show(r);
  tracker.setRoute(r);
  sim?.follow(r, true);
  routeLine = new Line(r.path);
  bends = new WeakMap();
  // The road watch measures along the line too: made again on the new one (what was said is kept), its features
  // asked for again at once, so the bands — 구간 단속, the school zones — are drawn along the line as it is now.
  if (watch && route === r) {
    watch = new RouteWatch(r, () => ({ wants: (k) => wants(guide, k), shows: (k) => shows(guide, k), cameraFromM: guide.cameraFromM }), warningsSaid);
    watchedAt = null;
  }
}
/** Routes whose line has been put onto the lanes (or asked to be): once each. */
const laned = new WeakSet<Route>();
/**
 * [r]'s line onto the travel-direction lanes where 정밀도로지도 has them, in the background (a long route takes
 * seconds), once: asked for the route chosen among the cards, so the line sits on the car's side of the road from
 * the first look, and for the route driven. When it comes, whatever shows the line is drawn again.
 */
function laneLine(r: Route) {
  if (laned.has(r)) return;
  laned.add(r);
  void snapRoute(r).then(() => {
    if (route === r) relined(r);
    else if (chosen === r && !el("s-preview").hidden) routeLayer.show(chosen, offers);
  });
}
function startDrive(r: Route) {
  const fresh = route == null;
  const elsewhere = !fresh && goal !== drivingTo;
  // A new route or a new place: the offer, and the way declined, are of the old one.
  clearFaster();
  if (fresh || elsewhere || r !== faster?.best) declinedS = null;
  route = r;
  // The line onto the travel-direction lanes where 정밀도로지도 has them (laneLine, often done while the cards were open).
  laneLine(r);
  chosen = r;
  drivingTo = goal;
  routeLayer.show(route);
  tracker.setRoute(route);
  sim?.follow(route);
  // What was said is kept across a re-route or a faster way to the same
  // place (the same camera, the same junction, once); a new place starts afresh.
  if (fresh || elsewhere) {
    turnsSaid.clear();
    linesSaid.clear();
    warningsSaid.clear();
    popups.clear();
    dismissed.clear();
    backoff.reset();
  }
  watch = new RouteWatch(route, () => ({ wants: (k) => wants(guide, k), shows: (k) => shows(guide, k), cameraFromM: guide.cameraFromM }), warningsSaid);
  watchedAt = null;
  incidentsAt = null;
  prepareHighway(route);
  if (!fresh && !elsewhere) reanchorPopups();
  void placeRestAreas(watch);
  arrived = false;
  showScreen("drive");
  setFollow(true);
  if (goal) remember(goal);
  if (resuming) voice.say(EVENTS.resumed);
  else if (fresh) voice.say(EVENTS.start);
  else if (elsewhere) voice.say(EVENTS.changed);
  resuming = false;
  // Kept for a reopened page, once it is clear this is not the pretend drive (started just after).
  setTimeout(keepDrive, 0);
  if (recheck == null) recheck = window.setInterval(() => void recheckRoute(), RECHECK_MS);
}

/** The drive in progress, written for a reopened page (resume.ts); the pretend drive is not. */
function keepDrive() {
  if (route && drivingTo && !sim?.running && !arrived) saveDrive({ to: drivingTo, provider: route.provider, at: Date.now() });
}
setInterval(keepDrive, 60_000);
/** The next startDrive is a drive taken up again after the page was closed. */
let resuming = false;

/**
 * A page opened while a drive was going on (closed by accident, or the car
 * after the phone): the same place, the same provider, from here — at once,
 * with a way to cancel, and a word that the voice needs a tap to be heard.
 */
async function resumeDrive() {
  const s = loadDrive();
  if (!s || route) return;
  // The first fix, if it comes soon; else the last place kept.
  for (let i = 0; i < 24 && !gps.last; i++) await new Promise((done) => setTimeout(done, 500));
  if (route) return;
  // Closed just short of the destination: that drive is over, not one to announce arrived at once more.
  if (!worthResuming(s, gps.last ? here() : null)) {
    log(`이전 안내 ${s.to.name}: 이미 도착지 근처라 잇지 않음`);
    saveDrive(null);
    return;
  }
  log(`이전 안내 이어가기: ${s.to.name} (${s.provider})`);
  let next: Route | null = null;
  try {
    next = await api.route(s.provider, here(), s.to.at);
  } catch {
    const answer = await api.routes(here(), s.to.at).catch(() => null);
    next = answer?.routes.sort((a, b) => a.durationS - b.durationS)[0] ?? null;
  }
  if (!next || route) return;
  goal = s.to;
  offers = [next];
  resuming = true;
  startDrive(next);
  const banner = el("resume");
  el("resume-text").textContent = `이전 안내를 이어갑니다 · ${s.to.name}` + (voice.context.state === "running" ? "" : " — 화면을 한 번 누르면 음성이 나옵니다");
  banner.hidden = false;
  setTimeout(() => { banner.hidden = true; }, 20_000);
}
el("resume-cancel").addEventListener("click", () => { el("resume").hidden = true; endDrive(); });

function endDrive() {
  clearFaster();
  declinedS = null;
  if (sim?.running) stopSim();
  saveDrive(null);
  route = null;
  goal = null;
  drivingTo = null;
  offers = [];
  chosen = null;
  routeLayer.show(null);
  tracker.setRoute(null);
  destPin?.remove();
  destPin = null;
  watch = null;
  drawNotes([]);
  zoneLayer.set([], null);
  cameraLayer?.setLightsAhead(null);
  el("next-light").hidden = true;
  if (recheck != null) clearInterval(recheck);
  recheck = null;
  // The camera card, the red speed and the next-camera mark: showLimit is only otherwise called from watchRoad.
  showLimit(null, null);
  closeupHold.reset();
  closeup = null;
  backoff.reset();
  el("turn-icon").replaceChildren();
  drawn.clear();
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
  el("pv-find").hidden = true;
  el("go-row").hidden = false;
  el("pv-msg").textContent = "경로 다시 찾는 중…";
  await fetchOffers();
});

/** Every few minutes on the way: a much quicker route from any provider wins. */
/**
 * 더 빠른 길: the quicker way the recheck found, drawn faint beside the route
 * and offered in the panel — taken by itself after FASTER_AUTO_MS unless the
 * driver says 그대로 (안내 설정: 자동), or only on a tap (물어보기).
 */
const FASTER_AUTO_MS = 20_000;
const FASTER_ASK_MS = 120_000;
let faster: { best: Route; to: Place; timer: number | null } | null = null;
/** The duration of the way declined with 그대로: nothing slower than it by less than BETTER_BY_S is offered again this drive. */
let declinedS: number | null = null;
function offerFaster(best: Route, to: Place, savedS: number) {
  clearFaster();
  const min = Math.max(1, Math.round(savedS / 60));
  routeLayer.show(route, [best]);
  el("faster-title").textContent = `${NAMES[best.provider]} 경로 · ${min}분 단축`;
  el("faster-sub").textContent = guide.fasterRoute === "auto" ? "20초 안에 고르지 않으면 바꿉니다" : "바꾸기를 누르면 이 길로, 아니면 지금 길 그대로";
  el("faster").hidden = false;
  voice.say(fasterPhrase(min), undefined, { key: `faster:${best.provider}:${min}` });
  // 자동: taken after a moment unless declined. 물어보기: the offer stands a couple of minutes, then counts as 그대로.
  faster = { best, to, timer: window.setTimeout(guide.fasterRoute === "auto" ? takeFaster : keepRoute, guide.fasterRoute === "auto" ? FASTER_AUTO_MS : FASTER_ASK_MS) };
}
function takeFaster() {
  const f = faster;
  clearFaster();
  if (!f || !route || drivingTo !== f.to) return;
  voice.say(EVENTS.faster);
  goal = f.to;
  startDrive(f.best);
}
function keepRoute() {
  if (faster) declinedS = faster.best.durationS;
  clearFaster();
  if (route) routeLayer.show(route);
}
function clearFaster() {
  if (faster?.timer != null) clearTimeout(faster.timer);
  faster = null;
  el("faster").hidden = true;
}
el("faster-go").addEventListener("click", takeFaster);
el("faster-keep").addEventListener("click", keepRoute);

async function recheckRoute() {
  if (!drivingTo || !route || !gps.last || rerouting || guide.fasterRoute === "off" || faster) return;
  if (!el("s-preview").hidden) return; // the cards are open; the driver is choosing
  if (stillness.still()) return; // parked a long while: the road has not changed for a car that does not move
  const asked = route, to = drivingTo;
  const current = tracker.frame()?.remainingS ?? route.durationS;
  try {
    const answer = await api.routes(here(), to.at);
    // An off-route re-route, a new place or the drive's end came while the answer did: it is for a route no longer driven.
    if (route !== asked || drivingTo !== to || rerouting) return;
    const best = answer.routes.sort((a, b) => a.durationS - b.durationS)[0];
    // Quicker by enough — and, after a "그대로", by enough more than the way declined.
    if (best && best.durationS < current - BETTER_BY_S && best.durationS < (declinedS ?? Infinity) - BETTER_BY_S) {
      offers = answer.routes;
      log(`더 빠른 길: ${best.provider} ${minutes(best.durationS)} (지금 ${minutes(current)})`);
      offerFaster(best, to, current - best.durationS);
    }
  } catch (e) {
    log(`재확인 실패 ${(e as Error).message}`);
  }
}

// Off the road (tracker.ts says when, and again while it stays off): the
// route is asked again from here — of the provider already driven, one
// call, so it comes back in a second; every provider only if that one
// fails. Which is quicker is the periodic recheck's question, not this one's.
/**
 * Re-routes in a row wait longer each time (reroute-backoff.ts): the tracker
 * starts afresh on each new route, so one that begins further from the car
 * than OFF_M has the car off again in a second or three, and without this the
 * road would be asked once a second for as long as that lasted.
 */
const backoff = new RerouteBackoff();
tracker.onOffRoute = async (at) => {
  if (!drivingTo || !route || rerouting) return;
  const wait = backoff.ask();
  if (wait > 0) {
    log(`경로 이탈 — 재탐색은 ${Math.ceil(wait)}초 뒤 (연달아 ${route.provider})`);
    return;
  }
  rerouting = true;
  log(`경로 이탈 — 재탐색 (${route.provider})`);
  voice.say(EVENTS.off);
  put("eta-left", "경로 이탈 · 재탐색 중…");
  const to = drivingTo;
  const asked = route;
  try {
    let next: Route | null = null;
    try {
      next = await api.route(route.provider, at, to.at);
    } catch (e) {
      log(`재탐색 ${route.provider} 실패 ${(e as Error).message} — 전체로`);
      const answer = await api.routes(at, to.at);
      const again = answer.routes.sort((a, b) => a.durationS - b.durationS);
      next = again.find((r) => r.provider === route!.provider) ?? again[0] ?? null;
      if (next) offers = again;
    }
    // The drive may have ended, gone elsewhere, or been given a quicker route (recheckRoute) while the answer came.
    if (next && drivingTo === to && route === asked) {
      if (!offers.includes(next)) offers = [next, ...offers.filter((r) => r.provider !== next!.provider)];
      goal = to;
      startDrive(next);
    }
  } catch (e) {
    log(`재탐색 실패 ${(e as Error).message}`);
  } finally {
    rerouting = false;
  }
};

/** The rungs already spoken, per guide (speech.ts decides which and when). */
const turnsSaid = new Map<string, Set<number>>();
/** Junctions whose guide line ("분홍색 유도선을 따라가세요") was said: once a junction, not at every far rung. */
const linesSaid = new Set<string>();
/** The same for the road's warnings, by feature. */
const warningsSaid = new Map<string, Set<number>>();
/** A junction's key: its place to about 20 m, since each provider puts the same turn a few metres apart. */
const junction = (at: LonLat) => `${Math.round(at[0] * 5000)},${Math.round(at[1] * 5000)}`;
let arrived = false;
const END_AFTER_ARRIVE_MS = 10_000;

/**
 * What the panel last showed, by element: written only when it changes. The
 * frame loop comes sixty times a second, and an innerHTML that is the same
 * string still costs a parse and a layout each time.
 */
const drawn = new Map<string, string>();
function put(id: string, text: string) {
  if (drawn.get(id) === text) return;
  drawn.set(id, text);
  el(id).textContent = text;
}
function putHtml(id: string, html: string) {
  if (drawn.get(id) === html) return;
  drawn.set(id, html);
  el(id).innerHTML = html;
}

function showTurn(shown: Shown) {
  if (!route) return;
  if (shown.remainingM != null && shown.remainingS != null) {
    put("eta-time", arrivalAt(shown.remainingS));
    put("eta-left", `${minutes(shown.remainingS)} · ${km(shown.remainingM)} · ${NAMES[route.provider]}`);
  }
  if (!shown.nextGuide) {
    if (shown.remainingM != null && shown.remainingM < 30 && !arrived) {
      arrived = true;
      saveDrive(null);
      voice.say(EVENTS.arrived);
      // 도착하면 안내 종료: back to the search screen once the arrival has been said, unless the driver ended it already.
      if (guide.endOnArrive) {
        const thisDrive = route;
        setTimeout(() => { if (route && route === thisDrive && arrived) endDrive(); }, END_AFTER_ARRIVE_MS);
      }
      putHtml("turn-icon", arrowSvg("arrive"));
      put("turn-in", "도착");
      put("turn-text", drivingTo?.name ?? "");
      el("then").hidden = true;
    }
    return;
  }
  const g = shown.nextGuide.guide;
  const m = maneuverFor(g);
  putHtml("turn-icon", arrowSvg(m));
  put("turn-in", km(shown.nextGuide.inM));
  put("turn-text", shortOf(g));
  if (shown.thenGuide && shown.thenGuide.inM - shown.nextGuide.inM < 800) {
    el("then").hidden = false;
    putHtml("then-icon", arrowSvg(maneuverFor(shown.thenGuide.guide), 20));
    put("then-text", `${km(shown.thenGuide.inM - shown.nextGuide.inM)} 후 ${shortOf(shown.thenGuide.guide)}`);
  } else {
    el("then").hidden = true;
  }
  const key = junction(g.at);
  const said = turnsSaid.get(key) ?? new Set<number>();
  turnsSaid.set(key, said);
  const due = turnSay(m, shown.nextGuide.inM, shown.speedMps * 3.6, said, g.text);
  if (!due || !guide.turns) return;
  const motorway = onMotorway.get(g) ?? false;
  // On a motorway, a far rung names the junction and its way; the plain sentence is said if that cannot be had.
  const named = motorway && guide.junctionNames && due.rung > TURN_NEAR_M ? namedFor(g, m, due.rung) : null;
  // A guide said in its own words ("고속도로 출구") is made on the spot; if that fails, the fixed sentence for the road's bend.
  const bent = TURN_WORDS_OK.has(m) ? null : bendOf(g);
  const plain = bent ? turnPhrase(bent, due.rung) : undefined;
  // Keyed by the junction and the rung: the next junction's "잠시 후 좌회전" is its own, however alike it reads.
  voice.say(named ?? due.text, named ? due.text : plain, { key: `turn:${key}:${due.rung}`, turn: true });
  // The first far rung (a kilometre out): the guide line's colour where it is painted, else which side to be on.
  const colour = due.rung > TURN_NEAR_M ? lineColour(g, m) : null;
  if (colour && guide.colorLines) {
    if (!linesSaid.has(key)) voice.say(GUIDE_LINES[colour], undefined, { key: `line:${key}`, turn: true });
    linesSaid.add(key);
  }
  else if (motorway && guide.laneHints && due.rung >= 1000 && !lanesShown) {
    const hint = laneHint(m);
    if (hint) voice.say(hint, undefined, { key: `lane:${key}`, turn: true });
  }
}

/** Which guides are on a motorway, worked out once a route. */
let onMotorway = new Map<Guide, boolean>();
/** The route's line, for the lanes' question (the heading in, the way after). */
let routeLine: Line | null = null;

// ---- 차로 안내: the lanes at the junction ahead (정밀도로지도, server/src/lanes.ts) ----

const LANES_TOWN_M = 800;
const LANES_MOTORWAY_M = 2000;
/** Asked once a junction; null while the answer is coming, or where the map has none. */
const lanesAsked = new Map<Guide, Lanes | null>();
let lanesShown = false;
function wayOf(m: Maneuver): string | null {
  if (m === "left" || m === "sharp-left") return "left";
  if (m === "right" || m === "sharp-right") return "right";
  if (m === "uturn") return "uturn";
  if (m === "straight") return "straight";
  if (m === "slight-left" || m === "slight-right" || m === "ramp-left" || m === "ramp-right" || m === "loop-left" || m === "loop-right") return "fork";
  return null;
}
/** The side to keep to before a turn, where the map has no lanes for it. */
function sideOf(m: Maneuver): string | null {
  if (m === "left" || m === "sharp-left" || m === "slight-left" || m === "ramp-left" || m === "loop-left" || m === "uturn") return "왼쪽 차로로";
  if (m === "right" || m === "sharp-right" || m === "slight-right" || m === "ramp-right" || m === "loop-right") return "오른쪽 차로로";
  return null;
}
const TURN_NAME: Partial<Record<Maneuver, string>> = {
  left: "좌회전", right: "우회전", "sharp-left": "왼쪽 급회전", "sharp-right": "오른쪽 급회전", "slight-left": "왼쪽 방향",
  "slight-right": "오른쪽 방향", "ramp-left": "왼쪽 출구", "ramp-right": "오른쪽 출구", uturn: "유턴", roundabout: "회전교차로", "loop-left": "왼쪽 램프", "loop-right": "오른쪽 램프",
};
// ---- lanes that must turn on the way straight on (정밀도로지도, lanesAlong on the server) ----

interface LaneStop { alongM: number; lanes: Lanes["lanes"]; way: LaneTurn }
/** The junctions ahead where some lane cannot go the route's way, by where their stop lines are along it. */
let laneStops: LaneStop[] = [];
let laneStopsAt: number | null = null;
const LANE_STOPS_AHEAD_M = 1500;
const LANE_STOP_SHOWN_M = 300;
/** Asked again each 800 m: the next kilometre and a half of the route, a point every 15 m. */
function askLaneStops(along: number) {
  if (!routeLine || !guide.laneGuide || health?.hdmap === false) return;
  if (laneStopsAt != null && Math.abs(along - laneStopsAt) < 800) return;
  laneStopsAt = along;
  const line = routeLine;
  const pts = [];
  for (let m = along; m <= Math.min(line.lengthM, along + LANE_STOPS_AHEAD_M); m += 15) pts.push(line.place(m).at);
  if (pts.length < 3) return;
  const path = pts.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(";");
  void fetch(`/api/hdmap/lanes-along?path=${path}`).then((a) => (a.ok ? a.json() : null)).then((j: { junctions?: (Lanes & { stop: LonLat; way: LaneTurn })[] } | null) => {
    if (line !== routeLine || !j?.junctions) return;
    // The server's word for the route's way at each stop line (from the route's shape past it).
    const found = j.junctions.map((x) => ({ alongM: line.project(x.stop, 0, line.path.length).alongM, lanes: x.lanes, way: x.way }));
    // Keep what is still ahead from the last answer, and take the new.
    laneStops = [...laneStops.filter((s) => s.alongM >= along - 20 && !found.some((f) => Math.abs(f.alongM - s.alongM) < 25)), ...found].sort((a, b) => a.alongM - b.alongM);
    if (found.length) log(`전용 차로 ${found.map((f) => `${Math.round(f.alongM - along)}m ${onlyWords(f.lanes, f.way)}`).join(", ")}`);
  }).catch(() => {});
}
/** The card for the next such stop line within 300 m: shown only, not said (the voice is kept for the turns). */
function nextLaneStop(along: number): LaneStop | null {
  // Going straight on past lanes that must turn: a turn of the route's own has its own card.
  // Kept until 30 m past the stop line: through the junction, not gone at its edge.
  return laneStops.find((x) => x.way === "straight" && x.alongM - along > -30 && x.alongM - along <= LANE_STOP_SHOWN_M) ?? null;
}
function laneStopCard(along: number): LaneCard | null {
  const s = nextLaneStop(along);
  if (!s) return null;
  const note = onlyWords(s.lanes, s.way);
  const arrow: Record<LaneTurn, Maneuver> = { straight: "straight", left: "left", right: "right", uturn: "uturn" };
  return {
    arrow: arrowSvg(arrow[s.way], 40),
    inText: km(Math.max(0, Math.round((s.alongM - along) / 10) * 10)),
    what: TURN_NAME[arrow[s.way]] ?? "직진",
    lanes: { lanes: s.lanes },
    side: null,
    note,
    way: s.way,
  };
}

/** Every turn has a card at the foot of the map; straight on, the arrival, the start and the wordless ones do not. */
const hasTurnCard = (m: Maneuver) => m !== "straight" && m !== "arrive" && m !== "depart" && m !== "other";
/** The turn just passed, kept on the card until the car is through the junction (TURN_HELD_M past it). */
let heldTurn: { guide: Guide; alongM: number } | null = null;
const TURN_HELD_M = 40;
/** The next guide as last seen, and where it lies along the route: when it gives way to the one after, it is held. */
let lastNext: { guide: Guide; alongM: number } | null = null;
function showLanes(shown: Shown) {
  let next = shown.nextGuide;
  if (shown.alongM != null && route) askLaneStops(shown.alongM);
  // The next guide changed while the last was close: the car is at that junction — hold it (a slow screen may
  // draw no frame in the last few metres before it, so the change itself is what is watched for).
  // Only a turn that has a card of its own is held: a 톨게이트 just passed held for 40 m hid the IC 300 m after it.
  if (lastNext && next?.guide !== lastNext.guide && shown.alongM != null && lastNext.alongM - shown.alongM < 30 && lastNext.alongM - shown.alongM > -TURN_HELD_M
    && hasTurnCard(maneuverFor(lastNext.guide))) heldTurn = lastNext;
  lastNext = next && shown.alongM != null ? { guide: next.guide, alongM: shown.alongM + next.inM } : null;
  // Through the junction the card stays: the guide just passed is still the one to show until 40 m on.
  if (heldTurn && shown.alongM != null && route && shown.alongM - heldTurn.alongM < TURN_HELD_M && route.guides.includes(heldTurn.guide)) {
    next = { guide: heldTurn.guide, inM: heldTurn.alongM - shown.alongM };
  } else heldTurn = null;
  const m = next && route ? maneuverFor(next.guide) : null;
  // Every turn (not straight on, not the arrival), from 400 m in town or a kilometre on a motorway.
  const within = next && m && route && routeLine && guide.laneGuide && hasTurnCard(m)
    && next.inM <= ((onMotorway.get(next.guide) ?? false) ? LANES_MOTORWAY_M : LANES_TOWN_M) && next.inM > -TURN_HELD_M;
  if (!within) {
    lanesShown = false;
    // No turn close: a lane ahead that must turn, if there is one within 300 m.
    drawLaneCard(el("lanes"), guide.laneGuide && route && shown.alongM != null ? laneStopCard(shown.alongM) : null);
    return;
  }
  // A stop line with a turning lane that comes before the turn: that first.
  const stop = shown.alongM != null ? nextLaneStop(shown.alongM) : null;
  if (stop && shown.alongM != null && stop.alongM - shown.alongM < next!.inM - 30) {
    drawLaneCard(el("lanes"), laneStopCard(shown.alongM));
    return;
  }
  const g = next!.guide;
  if (!lanesAsked.has(g) && health?.hdmap !== false) {
    lanesAsked.set(g, null);
    const line = routeLine!;
    const p = line.project(g.at, 0, line.path.length);
    const before = line.place(p.alongM - 30).at;
    const inDeg = bearing(before[0], before[1], p.at[0], p.at[1]);
    const after = Array.from({ length: 11 }, (_, k) => line.place(p.alongM + k * 15).at);
    const way = wayOf(maneuverFor(g));
    const q = new URLSearchParams({ at: `${g.at[0]},${g.at[1]}`, in: String(Math.round(inDeg)), after: after.map((a) => `${a[0].toFixed(6)},${a[1].toFixed(6)}`).join(";") });
    if (way) q.set("way", way);
    void fetch(`/api/hdmap/lanes?${q}`).then((a) => (a.ok ? a.json() : null)).then((info: Lanes | null) => {
      lanesAsked.set(g, info && info.lanes.length ? info : null);
      log(info?.lanes.length ? `차로 ${info.lanes.map((l) => (l.best ? `[${l.turns.join("+")}]` : l.turns.join("+"))).join(" | ")} · ${g.text}` : `차로 정보 없음 · ${g.text} (${way ?? "-"})`);
    }).catch(() => {});
  }
  const info = forNextTurn(lanesAsked.get(g) ?? null, shown);
  lanesShown = !!info;
  drawLaneCard(el("lanes"), {
    arrow: arrowSvg(m!, 40),
    inText: km(Math.max(0, Math.round(next!.inM / 10) * 10)),
    what: TURN_NAME[m!] ?? "",
    lanes: info,
    side: info ? null : sideOf(m!),
    lines: linesFor(g, m!),
    junction: junctionFor(g, m!),
  });
}

/** A turn this soon after the junction decides which of the lanes that can go the route's way to be in. */
const NEXT_TURN_M = 700;
/**
 * Of the lanes lit as able to go the route's way, when the turn after the
 * junction comes within NEXT_TURN_M and goes to a side, only the lanes on
 * that side stay lit (half of them, at least one); the others are shown as
 * able but not best — every straight lane lit told the driver nothing
 * about which one the next turn wants.
 */
function forNextTurn(info: Lanes | null, shown: Shown): Lanes | null {
  if (!info || !shown.nextGuide || !shown.thenGuide) return info;
  const gap = shown.thenGuide.inM - shown.nextGuide.inM;
  if (gap > NEXT_TURN_M) return info;
  const side = branchOf(maneuverFor(shown.thenGuide.guide));
  if (!side) return info;
  const best = info.lanes.map((l, i) => (l.best ? i : -1)).filter((i) => i >= 0);
  if (best.length < 2) return info;
  const keep = Math.max(1, Math.floor(best.length / 2));
  const chosen = new Set(side === "right" ? best.slice(-keep) : best.slice(0, keep));
  return { ...info, lanes: info.lanes.map((l, i) => (l.best && !chosen.has(i) ? { ...l, best: false, ok: true } : l)) };
}

/**
 * A motorway junction's picture: a fork at a JC (or a keep-left, keep-right on a motorway), an exit off
 * it, an entrance onto it — from the guide's words and whether the route is on a motorway there.
 */
function junctionFor(g: Guide, m: Maneuver): JunctionView | null {
  const go = branchOf(m);
  if (!go) return null;
  const t = g.text, j = junctionOf(g);
  const motorway = onMotorway.get(g) ?? false;
  const named = /IC|JC|분기|나들목|톨게이트|TG/.test(`${t} ${g.name ?? ""}`);
  if (!motorway && !named && !/고속|도시고속|자동차전용/.test(t)) return null;
  const kind: JunctionView["kind"] = /출구|진출/.test(t) ? "exit" : /입구|진입/.test(t) ? "enter" : "fork";
  if (kind === "fork" && !(m === "slight-left" || m === "slight-right" || m === "ramp-left" || m === "ramp-right" || m === "loop-left" || m === "loop-right")) return null;
  return { kind, go, name: j?.name, toward: j?.toward };
}

// ---- 노면색깔유도선: the pink or green line to follow at a motorway junction (color-guides.ts) ----

/** The junction's lines, asked once a guide; null where the list has none. */
const linesAsked = new Map<Guide, { left?: GuideColour; right?: GuideColour } | null>();
/** Which branch a manoeuvre takes; null for one that is not a fork. */
function branchOf(m: Maneuver): "left" | "right" | null {
  if (m === "slight-left" || m === "ramp-left" || m === "left" || m === "sharp-left" || m === "loop-left") return "left";
  if (m === "slight-right" || m === "ramp-right" || m === "right" || m === "sharp-right" || m === "loop-right") return "right";
  return null;
}
function linesFor(g: Guide, m: Maneuver): LaneCard["lines"] {
  const go = branchOf(m);
  const name = junctionOf(g)?.name;
  if (!go || !name || !guide.colorLines || !route || !routeLine) return null;
  if (!linesAsked.has(g)) {
    linesAsked.set(g, null);
    const line = routeLine;
    const p = line.project(g.at, 0, line.path.length);
    const before = line.place(p.alongM - 30).at;
    // The motorways named in this guide and the one before ("영동 고속도로를 따라"): the list's rows for that line.
    const n = route.guides.indexOf(g);
    const roads = [route.guides[n - 1]?.text, g.text].flatMap((t) => [...(t ?? "").matchAll(/([가-힣0-9]+)\s*(?:고속도로|고속국도|도시고속도로)/g)].map((x) => x[1]));
    const q = new URLSearchParams({ name, at: `${g.at[0]},${g.at[1]}`, in: String(Math.round(bearing(before[0], before[1], p.at[0], p.at[1]))), roads: [...new Set(roads)].join(",") });
    void fetch(`/api/road/color-guide?${q}`).then((a) => (a.ok ? a.json() : null)).then((c: { left?: GuideColour; right?: GuideColour } | null) => {
      const found = c && (c.left || c.right) ? c : null;
      linesAsked.set(g, found);
      log(found ? `유도선 ${name}: 왼쪽 ${found.left ?? "-"} · 오른쪽 ${found.right ?? "-"}` : `유도선 없음 · ${name}`);
    }).catch(() => {});
  }
  const c = linesAsked.get(g);
  if (!c) return null;
  // One line alone is the exit's: it leads off the motorway, whichever side the list wrote it on.
  if (!(c.left && c.right)) {
    const exit = /출구|진출|나들목|IC/.test(g.text) && !/JC|분기/.test(g.text);
    const only = c.left ?? c.right;
    return exit ? { [go]: only, go } : null;
  }
  return { left: c.left, right: c.right, go };
}

/** The colour to follow at [g], when its lines are known. */
function lineColour(g: Guide, m: Maneuver): GuideColour | null {
  const l = linesFor(g, m);
  return l ? l[l.go] ?? null : null;
}
const TURN_WORDS_OK = new Set<Maneuver>(["left", "right", "slight-left", "slight-right", "sharp-left", "sharp-right", "ramp-left", "ramp-right", "uturn", "roundabout", "straight"]);
function namedFor(g: Guide, m: Maneuver, rung: number): string | null {
  if (!TURN_WORDS_OK.has(m)) return null;
  const j = junctionOf(g);
  return j ? namedTurnPhrase(m as Turn, rung, j) : null;
}
/** Junction words with no side in them ("분기도로 진입", "고속도로 출구"): the side is the road's to show. */
const JUNCTION_WORDS = /분기|진입|진출|출구|램프|IC|JC|나들목/;
const TOLL_WORDS = /톨게이트|요금소/;
/** Guides whose way was read off the bend, once each. */
const bentWays = new WeakMap<Guide, Maneuver>();
/**
 * A guide's way on this route: its words, else its code (maneuverOf), else,
 * for a junction that names no side, the way the road bends there. Without
 * that a "분기도로 진입" had a dot for an arrow, no picture of the fork and
 * no side said.
 */
function maneuverFor(g: Guide): Maneuver {
  const m = maneuverOf(route!.provider, g);
  const words = `${g.text} ${g.name ?? ""}`;
  if (m !== "other" || !JUNCTION_WORDS.test(words) || TOLL_WORDS.test(words)) return shapedOf(m, bendAt(g));
  let bent = bentWays.get(g);
  if (bent === undefined) {
    if (!routeLine) return m;
    bent = bendOf(g) ?? "other";
    bentWays.set(g, bent);
  }
  return shapedOf(bent, bendAt(g));
}
/** The road's shape at each guide, measured once a route (bends and loops: shapedOf). */
let bends = new WeakMap<Guide, Bend | null>();
function bendAt(g: Guide): Bend | null {
  let b = bends.get(g);
  if (b !== undefined) return b;
  if (!routeLine) return null;
  const at = routeLine.project(g.at, 0, routeLine.path.length).alongM;
  const turn = (a: number, c: number) => ((routeLine!.place(c).bearing - routeLine!.place(a).bearing + 540) % 360) - 180;
  let sweep = 0;
  for (let m = at; m < at + 200 && m < routeLine.lengthM; m += 20) sweep += turn(m, Math.min(m + 20, routeLine.lengthM));
  b = { d60: turn(Math.max(0, at - 60), Math.min(routeLine.lengthM, at + 60)), sweep200: sweep };
  bends.set(g, b);
  return b;
}

/**
 * The way the route bends at [g]: its bearing 100 m before against 100 m
 * after (a fork parts slowly; over 40 m most read under 10°). A motorway
 * exit that bends neither way clearly is on the right, as nearly all are.
 */
function bendOf(g: Guide): Turn | null {
  if (!routeLine) return null;
  const at = routeLine.project(g.at, 0, routeLine.path.length).alongM;
  const exit = /출구|진출/.test(g.text) && (onMotorway.get(g) ?? false);
  return fromBend(routeLine.place(at - 100).bearing, routeLine.place(at + 100).bearing, exit) ?? (exit ? "ramp-right" : null);
}
/** A new route: which guides are on motorways, and their named sentences asked for now, to be ready. */
function prepareHighway(r: Route) {
  const line = new Line(r.path);
  routeLine = line;
  lanesAsked.clear();
  linesAsked.clear();
  laneStops = [];
  laneStopsAt = null;
  // The junction held close up was measured along the old line; on this one its metres would read as kilometres.
  closeupHold.reset();
  closeup = null;
  onMotorway = new Map(r.guides.map((g) => [g, motorwayAt(r, line.project(g.at, 0, r.path.length).segment)]));
  if (!guide.junctionNames || !guide.turns) return;
  for (const g of r.guides) {
    if (!onMotorway.get(g)) continue;
    const m = maneuverFor(g);
    for (const rung of [1000, 500]) {
      const text = namedFor(g, m, rung);
      if (text) voice.prefetch(text);
    }
  }
}

/** A guide as the panel shows it: without TMAP's "… 후 영동 고속도로를 따라 121m 이동" tail. */
const shortGuide = (text: string) => text.replace(/\s*후\s+.*?(을|를)?\s*따라\s*\d+\s*m\s*이동\s*$/, "").replace(/\s*(을|를)\s*따라\s*\d+\s*m\s*이동\s*$/, "").trim() || text;
/** The same, once a guide (it is asked for every frame). */
const shortGuides = new WeakMap<Guide, string>();
function shortOf(g: Guide): string {
  let short = shortGuides.get(g);
  if (short === undefined) shortGuides.set(g, (short = shortGuide(g.text)));
  return short;
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
/** Where each warning sentence was last said from: two features this close are one thing to say. */
const spokenAt = new Map<string, { at: LonLat; t: number }>();
const SAME_PLACE_M = 300;
/** Where the server was last asked what is near; asked again 500 m on or after 30 s. */
let watchedAt: { at: LonLat; t: number } | null = null;
/** Parked with the page open (still.ts): the polls that follow the car wait until it moves. */
const stillness = new Stillness();

async function watchRoad(fix: Fix) {
  const w = watch, r = route;
  if (!w || !r) return;
  const moved = watchedAt ? metres(watchedAt.at[0], watchedAt.at[1], fix.lon, fix.lat) : Infinity;
  if ((moved > 500 || !watchedAt || Date.now() - watchedAt.t > 30_000) && !stillness.still()) {
    watchedAt = { at: [fix.lon, fix.lat], t: Date.now() };
    try {
      const near = await (await fetch(`/api/safety/near?lon=${fix.lon}&lat=${fix.lat}&r=1500`)).json() as Feature[];
      // The drive ended, or was re-routed, while the answer came: this watch is no longer the one.
      if (watch !== w) return;
      w.add(near);
    } catch (e) {
      log(`시설물 조회 실패 ${(e as Error).message}`);
    }
  }
  if (watch !== w) return;
  if (!incidentsAt || Date.now() - incidentsAt.t > INCIDENTS_EVERY_MS || metres(incidentsAt.at[0], incidentsAt.at[1], fix.lon, fix.lat) > 8000) {
    void placeIncidents(w, [fix.lon, fix.lat]);
  }
  const along = tracker.frame()?.alongM;
  if (along == null) return;
  for (const due of w.due(along)) {
    // Only shown: a card now, gone when passed or tapped; the voice is left for what cannot wait.
    if (!due.voice) {
      // A rest area only once on the motorway (roadNotes has the same rule for its card).
      if (due.feature.kind === "rest-area" && !(routeLine && motorwayAt(r, routeLine.place(along).segment))) continue;
      popups.set(due.feature.id, due);
      continue;
    }
    const phrase = phraseFor(due);
    // One sentence for things at one place (a school zone and its camera); a second camera further on is its own.
    const f = due.feature;
    const same = spokenAt.get(phrase);
    if (same && metres(same.at[0], same.at[1], f.lon, f.lat) < SAME_PLACE_M && Date.now() - same.t < 20_000) continue;
    spokenAt.set(phrase, { at: [f.lon, f.lat], t: Date.now() });
    log(`경고 ${phrase}`);
    voice.say(phrase, undefined, { key: `warn:${f.id}:${due.rungM}` });
  }
  showLimit(w.limitAt(along), fix.speed);
  showNextLight(w, along, fix.speed);
  // The protected zones on the route, as bands on the road (those the driver keeps shown).
  zoneLayer.set([
    ...w.zones().filter((z) => shows(guide, z.feature.kind)).map((z) => ({ id: z.feature.id, kind: z.feature.kind as "school-zone" | "senior-zone", alongM: z.alongM, endM: z.endM })),
    // 구간 단속: the stretch between its cameras, painted whether or not its cameras are said.
    ...w.sections().map((s) => ({ id: `section:${s.feature.id}`, kind: "section" as const, alongM: s.alongM, endM: s.endM })),
  ], routeLine);
  drawNotes(roadNotes(w, along));
}

/** Lights this close along the route are one junction's; the nearest ahead of the car is "the next". */
const LIGHTS_ONE_JUNCTION_M = 40;
const LIGHTS_ON_MAP_M = 3000;
/**
 * The next traffic light on the route, on the drive panel, with the time to
 * it at this speed; and the route's lights ahead handed to the map, which
 * (안내 설정 → 경로만) draws only those.
 */
function showNextLight(w: RouteWatch, along: number, speedMps: number | null | undefined) {
  const aheadAll = w.ahead(along, LIGHTS_ON_MAP_M);
  const lights = aheadAll.filter((a) => a.feature.kind === "signal-light");
  // The lights and the cameras on the route ahead: the ones the map draws (경로만).
  cameraLayer?.addKnown(aheadAll.map((a) => a.feature));
  cameraLayer?.setLightsAhead(new Set(aheadAll.map((a) => a.feature.id)));
  const line = el("next-light");
  // Past the stop line of the one being driven through: the next junction's.
  const next = lights.find((a) => a.inM > 8);
  line.hidden = !guide.nextLight || !next;
  if (!next || line.hidden) return;
  const count = new Set(lights.map((a) => Math.round(a.alongM / LIGHTS_ONE_JUNCTION_M))).size;
  const secs = speedMps && speedMps > 3 ? Math.round(next.inM / speedMps) : null;
  el("next-light-in").textContent = km(next.inM);
  el("next-light-sub").textContent = [secs != null ? `약 ${secs}초` : null, count > 1 ? `앞 ${count}곳` : null].filter(Boolean).join(" · ");
}

// ---- shown, not said: the cards at the top right ---------------------------

const notes = new Notes(el("notes"));
const zoneLayer = new ZoneLayer(map);
/** The things only shown that have come due this drive, until passed; and the cards the driver closed. */
const popups = new Map<string, Ahead>();
/**
 * A new line to the same place (a re-route, a faster way): the cards up
 * are measured again along it. Their metres were the old line's, and a
 * curve already passed read "32.1 km" on the new one, never to go.
 * One the new line does not pass is dropped.
 */
function reanchorPopups() {
  if (!routeLine) return;
  const line = routeLine;
  for (const [id, p] of popups) {
    const on = line.project([p.feature.lon, p.feature.lat], 0, line.path.length);
    if (on.offM > 60) { popups.delete(id); continue; }
    // An area (a zone, a hotspot's circle) is placed round its middle; a point at itself.
    const shift = on.alongM - (p.alongM + (p.endM ?? p.alongM)) / 2;
    popups.set(id, { ...p, alongM: p.alongM + shift, endM: p.endM != null ? p.endM + shift : undefined });
  }
}
const dismissed = new Set<string>();
notes.onDismiss = (id) => dismissed.add(id);
/** More cards than this and the map is covered: the nearest are kept. */
const MAX_NOTES = 4;
/** The road's cards as last drawn, so a new 기상특보 can be added without waiting for a fix. */
let lastRoadNotes: Note[] = [];
function drawNotes(road: Note[]) {
  lastRoadNotes = road;
  const seen = new Set<string>();
  const list = [...alertNotes(), ...road].filter((n) => !dismissed.has(n.id) && !seen.has(n.id) && seen.add(n.id));
  notes.show(list.slice(0, MAX_NOTES));
}

/** How far ahead each card is shown from: a rest area tens of kilometres out is worth knowing. */
const REST_SHOWN_M = 20_000;
const INCIDENT_SHOWN_M = 5000;
const SCHOOL_SHOWN_M = 500;

/** The next of each: one rest area, one incident, one school zone, nearest first. */
function roadNotes(w: RouteWatch, along: number): Note[] {
  const ahead = w.ahead(along, REST_SHOWN_M).filter((a) => shows(guide, a.feature.kind));
  const first = (test: (a: Ahead) => boolean, withinM: number) => ahead.find((a) => test(a) && a.inM <= withinM);
  const out: Note[] = [];
  const school = first((a) => a.feature.kind === "school-zone", SCHOOL_SHOWN_M);
  if (school) out.push(schoolNote(school, along));
  const incident = first((a) => INCIDENT_KINDS.includes(a.feature.kind) && a.inM >= -10, INCIDENT_SHOWN_M);
  if (incident) out.push(incidentNote(incident));
  // The things only shown, nearest first, until the car is past each.
  for (const [id, p] of popups) {
    if ((p.endM ?? p.alongM) < along - 10) popups.delete(id);
  }
  out.push(...[...popups.values()].sort((a, b) => a.alongM - b.alongM).map((p) => popupNote(p, along)));
  // A rest area is for the motorway: shown only once the car is on one, not while still leaving town.
  const onMotorwayNow = !!route && !!routeLine && motorwayAt(route, routeLine.place(along).segment);
  const rest = onMotorwayNow ? first((a) => a.feature.kind === "rest-area" && a.inM >= 0, REST_SHOWN_M) : undefined;
  if (rest) out.push(restNote(rest));
  return out;
}

/** Every rest area, asked once per page: the server has them all, and their prices by the hour. */
let restAreas: Promise<Feature[]> | null = null;
async function placeRestAreas(w: RouteWatch) {
  if (health?.road && !health.road.restAreas) return;
  restAreas ??= fetch("/api/road/rest-areas").then(async (a) => {
    if (!a.ok) throw new Error((await a.json().catch(() => ({}))).error ?? `${a.status}`);
    return (await a.json()) as Feature[];
  });
  try {
    const list = await restAreas;
    if (watch === w) w.add(list);
  } catch (e) {
    restAreas = null;
    log(`휴게소 실패 ${(e as Error).message}`);
  }
}

const INCIDENT_KINDS: Kind[] = ["incident-crash", "incident-work", "incident-other"];
const INCIDENTS_EVERY_MS = 3 * 60_000;
let incidentsAt: { at: LonLat; t: number } | null = null;
/** ITS's incidents round the car, again every few minutes: the cleared ones go, the new ones come. */
async function placeIncidents(w: RouteWatch, at: LonLat) {
  if (health?.road && !health.road.incidents) return;
  incidentsAt = { at, t: Date.now() };
  try {
    const a = await fetch(`/api/road/incidents?at=${at[0]},${at[1]}&r=15000`);
    if (!a.ok) throw new Error((await a.json().catch(() => ({}))).error ?? `${a.status}`);
    const list = (await a.json()) as Feature[];
    if (watch !== w) return;
    w.drop(INCIDENT_KINDS);
    w.add(list);
  } catch (e) {
    log(`돌발상황 실패 ${(e as Error).message}`);
  }
}

// ---- 기상특보 ---------------------------------------------------------------

interface Alert { kind: string; level: "주의보" | "경보"; where: "here" | "part"; area: string }
let alertsNow: Alert[] = [];
let alertsAt: { at: LonLat; t: number } | null = null;
/** Each 특보 is said once a page: the voice is for its arrival, the card for its staying. */
const alertsSaid = new Set<string>();

async function refreshAlerts(at: LonLat) {
  if (health?.road && !health.road.alerts) return;
  const moved = alertsAt ? metres(alertsAt.at[0], alertsAt.at[1], at[0], at[1]) : Infinity;
  if (alertsAt && moved < 10_000 && Date.now() - alertsAt.t < 10 * 60_000) return;
  alertsAt = { at, t: Date.now() };
  try {
    const a = await fetch(`/api/alerts?at=${at[0]},${at[1]}`);
    const j = (await a.json()) as { alerts?: Alert[]; error?: string };
    if (!a.ok) throw new Error(j.error ?? `${a.status}`);
    alertsNow = j.alerts ?? [];
    for (const al of alertsNow) {
      const key = `${al.kind}${al.level}`;
      if (alertsSaid.has(key) || guide.weatherAlerts !== "voice" || !(ALERT_KINDS as readonly string[]).includes(al.kind)) continue;
      alertsSaid.add(key);
      voice.say(alertPhrase(al.kind as AlertKind, al.level));
    }
    drawNotes(lastRoadNotes);
  } catch (e) {
    log(`기상특보 실패 ${(e as Error).message}`);
  }
}

function alertNotes(): Note[] {
  if (guide.weatherAlerts === "off") return [];
  return alertsNow.map((al) => ({
    id: `alert:${al.kind}${al.level}`,
    tone: "alert" as const,
    badge: "기상특보",
    title: `${al.kind}${al.level}`,
    where: al.where === "here" ? "이 지역" : "일부 지역",
    lines: [al.area],
  }));
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
  // The camera it is about, marked on the map (camera-layer.ts): the one the warning counts down to.
  cameraLayer?.setNextCamera(held?.why === "camera" && held.id ? held.id : null);
  const kmh = speedMps == null ? null : speedMps * 3.6;
  const over = !!held && kmh != null && kmh > held.limit + guide.overspeedBy;
  document.querySelector(".big")!.classList.toggle("over", over);
  document.body.classList.toggle("over-limit", over);
  if (!held) return;
  el("cam-limit").textContent = String(held.limit);
  el("cam-what").textContent = held.why === "section" ? "구간 단속 중" : held.why === "school" ? "보호구역" : `단속 카메라 ${km(held.inM ?? 0)}`;
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
setInterval(() => void refreshAlerts(here()), 60_000);
map.once("load", () => void refreshAlerts(here()));

const guide = loadGuide();
/** The screen's theme where the car is: the lane lines' colour, and the lit buildings, follow it. */
function themed(day: boolean) {
  hdLayer?.setDay(day);
  nightCity?.setNight(!day);
}
function applyGuide() {
  document.body.classList.toggle("layout-mini", guide.layout === "mini");
  themed(applyTheme(guide.theme, here()));
  hdLayer?.refresh();
  nightCity?.refresh();
  // 화면 크기: everything over the map scaled together (style.css zooms the overlays by --ui).
  document.documentElement.style.setProperty("--ui", String(guide.uiScale || 1));
  voice.enabled = guide.voice;
  voice.ducking = guide.ducking;
  voice.voiceName = guide.voiceName;
  voice.setVolume(guide.volume);
  cameraLayer?.redraw();
}
// The cameras on the map, the kinds the driver asked to hear (안내 설정).
const cameraLayer: CameraLayer | null = new CameraLayer(map, (f, ahead) => {
  // 경로만: what is on the route ahead while driving, and none otherwise — the map when only looked at stays clear.
  const mode = f.kind === "signal-light" ? guide.lightsOnMap : guide.camerasOnMap;
  if (f.kind !== "signal-light" && !wants(guide, f.kind)) return false;
  if (mode === "route") return !!ahead?.has(f.id);
  return mode === "all";
}, log);
// A light turning to flashing at midnight turns amber on the map; the screen turns dark at dusk.
setInterval(() => { cameraLayer?.redraw(); themed(applyTheme(guide.theme, here())); }, 60_000);
// 정밀도로지도's lanes on the ground, close in; white by night, grey on a light day map.
const hdLayer: HdLayer | null = new HdLayer(map, () => guide.hdLanes);
// 야경: the buildings lit by night, only in the tilted view and where the driver left it on.
nightCity = new NightCity(map, () => guide.nightCity && view === "3d" && base !== "osm", showBuildings);
themed(applyTheme(guide.theme, loadLast() ?? HOME));
/** 들어보기: a warning and a turn, as the drive will say them, from the settings sheet. */
function listenSample() {
  voice.preview(warningPhrase("speed", 600, 50));
  voice.preview(turnPhrase("left", 1000));
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
    // Only the trip panel at the top left stays: every other window goes, so the sheet has the screen.
    nearby.show(false);
    openDock(false);
    el("weather").hidden = true;
    el("base-menu").hidden = true;
    closeHere();
    if (currentScreen === "search") openSearch(false);
    drawGuide(el("guide-rows"), guide, applyGuide, loadVoices, voicePicked, listenSample);
  }
  sideChanged();
}
el("guide-open").addEventListener("click", () => openGuide(el("guide").hidden));
el("guide-close").addEventListener("click", () => openGuide(false));
el("account-name").textContent = currentUser() ? `${currentUser()!.name} 로 로그인됨` : "";
el("logout").addEventListener("click", () => void logout());

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
  // No account connected: no music button either (it is back once one is, on the next load).
  el("music-dock").hidden = connected.length === 0 && !music;
  // No music button: 현위치 comes down to where it was.
  document.body.classList.toggle("no-music", el("music-dock").hidden);
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

/** The music's level as last set, and the fade under way: the voice asks for a level and how long to take. */
let musicLevel = 1;
let fading = 0;
function duckBySource(level: number, overMs: number) {
  cancelAnimationFrame(fading);
  const from = musicLevel, started = performance.now();
  if (overMs <= 0) { musicLevel = level; music?.setVolume(level); return; }
  const step = (t: number) => {
    const share = Math.min(1, (t - started) / overMs);
    // Eased both ways, so neither the dip nor the return is heard as a step.
    const eased = share < 0.5 ? 2 * share * share : 1 - Math.pow(-2 * share + 2, 2) / 2;
    musicLevel = from + (level - from) * eased;
    music?.setVolume(musicLevel);
    if (share < 1) fading = requestAnimationFrame(step);
  };
  fading = requestAnimationFrame(step);
}

/** A playing (or paused mid-song) player keeps its bar; with nothing on, the dock shrinks to a button. */
function drawDockSize() {
  const compact = !now.playing && !now.title;
  el("music-dock").classList.toggle("compact", compact);
  // With a song on, the dock is a wide bar at the foot on the right: the cards at the foot keep clear of it (style.css).
  document.body.classList.toggle("music-on", !compact);
}

/** Round, soft icons for the transport (an emoji font may be missing in the car). */
const ICONS = {
  heart: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20.5s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7.7a4.5 4.5 0 0 1 7.5 2.8c0 5.4-7.5 10-7.5 10z"/></svg>`,
  heartOn: `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 20.5s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7.7a4.5 4.5 0 0 1 7.5 2.8c0 5.4-7.5 10-7.5 10z" fill="currentColor"/></svg>`,
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

/** What the dock last drew: the track, its state and its note. A time tick with the same draws only the progress. */
let drawnNow = "";
function showNow(state: NowPlaying) {
  now = state;
  nowAt = performance.now();
  // The player reports its time several times a second; the track, the art, the buttons and the media session
  // are drawn again only when one of them changed (each redraw re-made two SVGs and a MediaMetadata).
  const key = `${state.title ?? ""}\u0001${state.artist ?? ""}\u0001${state.art ?? ""}\u0001${state.playing ? 1 : 0}\u0001${state.note ?? ""}\u0001${state.durationS ?? ""}\u0001${state.liked === undefined ? "" : state.liked ? 1 : 0}`;
  if (key === drawnNow) { drawProgress(); return; }
  drawnNow = key;
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
  // The heart: only where the service says whether the track is liked (TIDAL), filled when it is.
  const heart = el("music-like");
  heart.hidden = state.liked === undefined || !music?.like;
  el("transport-pad").hidden = !heart.hidden;
  heart.classList.toggle("on", !!state.liked);
  heart.setAttribute("aria-pressed", String(!!state.liked));
  heart.innerHTML = state.liked ? ICONS.heartOn : ICONS.heart;
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
  if (typeof ms.setPositionState === "function" && typeof state.durationS === "number" && state.durationS > 0) {
    try {
      ms.setPositionState({
        duration: state.durationS,
        playbackRate: 1,
        position: Math.min(Math.max(0, state.positionS ?? 0), state.durationS),
      });
    } catch {
      /* not supported or invalid state */
    }
  }
  if (sessionWired) return;
  sessionWired = true;
  const on = (action: MediaSessionAction, fn: (details: MediaSessionActionDetails) => void) => { try { ms.setActionHandler(action, fn); } catch { /* not this one */ } };
  on("play", () => void music?.toggle().catch(onMusicError));
  on("pause", () => void music?.toggle().catch(onMusicError));
  on("nexttrack", () => void music?.next().catch(onMusicError));
  on("previoustrack", () => void music?.previous().catch(onMusicError));
  on("seekto", (details) => {
    if (typeof details.seekTime === "number") {
      void music?.seek?.(details.seekTime).catch(onMusicError);
    }
  });
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
el("music-like").addEventListener("click", () => void music?.like?.(!now.liked).catch(onMusicError));
el("music-toggle").addEventListener("click", () => void music?.toggle().catch(onMusicError));
el("music-next").addEventListener("click", () => void music?.next().catch(onMusicError));
el("music-prev").addEventListener("click", () => void music?.previous().catch(onMusicError));
el("mini-toggle").addEventListener("click", (e) => { e.stopPropagation(); void music?.toggle().catch(onMusicError); });
el("mini-next").addEventListener("click", (e) => { e.stopPropagation(); void music?.next().catch(onMusicError); });
void drawSources();

// ---- a pretend drive -------------------------------------------------------

let sim: Simulator | null = null;
/** The car's last real fix before a pretend drive: where the map goes back to when it ends. */
let realFix: LonLat | null = null;

function simSpeed(): number {
  return Number(el<HTMLInputElement>("sim-speed").value) / 3.6;
}
el<HTMLInputElement>("sim-speed").addEventListener("input", () => {
  el("sim-speed-label").textContent = el<HTMLInputElement>("sim-speed").value;
  // The bar on the drive screen too, whichever control moved it.
  el("sim-kmh").textContent = el<HTMLInputElement>("sim-speed").value;
  if (sim) sim.speedMps = simSpeed();
});
function startSim() {
  if (!route) { log("모의 주행: 먼저 경로가 있어야 합니다"); return; }
  sim?.stop();
  realFix = gps.last ? [gps.last.lon, gps.last.lat] : null;
  sim = new Simulator(gps, route);
  sim.speedMps = simSpeed();
  sim.onEnd = () => { simEnded(); log("모의 주행 끝"); };
  sim.start();
  el("sim-toggle").classList.add("on");
  el("sim-bar").hidden = false;
  el("sim-kmh").textContent = el<HTMLInputElement>("sim-speed").value;
  log(`모의 주행 시작 ${Math.round(sim.speedMps * 3.6)} km/h`);
}
function stopSim() {
  sim?.stop();
  simEnded();
}
/** The pretend drive over, by itself or stopped: its bar away, and the car's own fixes back (Simulator.start took them). */
function simEnded() {
  el("sim-toggle").classList.remove("on");
  el("sim-bar").hidden = true;
  gps.start();
  // Back to where the car really is, at once: the drawn car forgets the pretend place, and the map goes to the last real fix.
  tracker.forget();
  if (realFix) {
    marker.setLngLat(realFix);
    map.jumpTo({ center: realFix });
    setFollow(true);
  }
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
  health = { ok: true, providers: { tmap: true, kakao: true, naver: true, osrm: true, korea: false }, safetyFeatures: 48210, search: true, tts: true };
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
  voice.say = (text: string, fallback?: string, opts?: Parameters<Voice["say"]>[2]) => {
    // Where the next turn was when this was said, to tell one junction said twice from two junctions.
    const next = tracker.frame()?.nextGuide;
    said.push({ t: Date.now(), text, guide: next ? `${junction(next.guide.at)} in ${Math.round(next.inM)}m` : "" } as { t: number; text: string });
    say(text, fallback, opts);
  };
  // What was heard, played in full or not, and what was dropped for being late.
  const heard: { t: number; text: string; playedS: number; lengthS: number; waitedS: number }[] = [];
  const late: { t: number; text: string; waitedS: number }[] = [];
  const onSaid = voice.onSaid, onLate = voice.onLate;
  voice.onSaid = (text, playedS, lengthS, waitedS) => { heard.push({ t: Date.now(), text, playedS, lengthS, waitedS }); onSaid(text, playedS, lengthS, waitedS); };
  voice.onLate = (text, waitedS) => { late.push({ t: Date.now(), text, waitedS }); onLate(text, waitedS); };
  (window as unknown as { nav: unknown }).nav = {
    said, heard, late, voice, tracker, gps, map, lanesAsked,
    get heldTurn() { return heldTurn; },
    get route() { return route; },
    get watch() { return watch; },
    get sim() { return sim; },
    recheck: () => recheckRoute(),
    /** Each guide of the route with the way it is shown and said as. */
    ways: () => route?.guides.map((g) => ({ text: g.text, name: g.name, code: g.turnType, m: maneuverFor(g) })) ?? [],
  };
}

// The log to the server every half-minute, and as the page goes to the back or away (a beacon, which outlives it).
function sendLog(beacon = false) {
  if (!unsent.length || typeof guide === "undefined" || !guide.sendLogs) return;
  const body = JSON.stringify({ lines: unsent.splice(0, unsent.length) });
  if (beacon && navigator.sendBeacon) navigator.sendBeacon("/api/me/log", new Blob([body], { type: "application/json" }));
  else void fetch("/api/me/log", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
}
setInterval(() => sendLog(), 30_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") sendLog(true); });
window.addEventListener("pagehide", () => sendLog(true));

// Audio only starts after a tap, and the car's browser can put it back to sleep: every tap wakes it.
document.addEventListener("pointerdown", () => void voice.unlock().then(() => { el("voice").textContent = voice.context.state; showAudioLocked(); }));
voice.context.addEventListener("statechange", () => { el("voice").textContent = voice.context.state; showAudioLocked(); });
/** While driving with the voice on and the sound asleep: a line saying a tap brings it back. */
function showAudioLocked() {
  el("audio-locked").hidden = voice.awake || !route || !guide.voice;
}
setInterval(showAudioLocked, 2000);

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
  void resumeDrive();
});
