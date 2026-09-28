import maplibregl from "maplibre-gl";
import { api } from "./api";
import { Gps, type Fix } from "./gps";
import { chime, keepAwake } from "./probes";
import { Replay } from "./replay";
import { RouteLayer } from "./route-layer";
import type { Health, LonLat, Place, Provider, Route } from "./types";

// A key-free vector style; swap for a Mapbox/VWorld style URL through
// VITE_MAP_STYLE once Korean coverage has been compared in the car.
const style = import.meta.env.VITE_MAP_STYLE ?? "https://tiles.openfreemap.org/styles/liberty";
const HOME: LonLat = [127.0276, 37.4979];

const map = new maplibregl.Map({
  container: "map",
  style,
  center: HOME,
  zoom: 15,
  pitch: 45,
  attributionControl: false,
});

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
gps.onError = (m) => log(`GPS 오류 ${m}`);
gps.on(onFix);

function onFix(fix: Fix) {
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
  marker.setLngLat([fix.lon, fix.lat]);
  if (follow) {
    map.easeTo({ center: [fix.lon, fix.lat], bearing: fix.course ?? map.getBearing(), duration: 900, easing: (t) => t });
  }
}

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
let provider: Provider = "tmap";
let goal: Place | null = null;
let route: Route | null = null;
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

async function go(place: Place) {
  goal = place;
  el("trip").hidden = false;
  el("trip-name").textContent = place.name;
  el("trip-sum").textContent = "경로 찾는 중…";
  drawProviders();
  try {
    route = await api.route(provider, here(), place.at);
    routeLayer.show(route);
    el("trip-sum").textContent = `${km(route.distanceM)} · ${minutes(route.durationS)} · ${route.provider}`;
    log(`경로 ${route.provider}: ${route.path.length}점 ${route.guides.length}안내 ${route.segments.length}구간`);
    setFollow(false);
    routeLayer.fit(route);
  } catch (e) {
    route = null;
    routeLayer.show(null);
    el("trip-sum").textContent = `경로 실패: ${(e as Error).message}`;
  }
}

function drawProviders() {
  const row = el("providers");
  row.replaceChildren();
  const names: Record<Provider, string> = { tmap: "티맵", kakao: "카카오", naver: "네이버" };
  for (const name of ["tmap", "kakao", "naver"] as Provider[]) {
    if (health && !health.providers[name]) continue;
    const b = document.createElement("button");
    b.textContent = names[name];
    b.classList.toggle("on", name === provider);
    b.addEventListener("click", () => {
      provider = name;
      if (goal) void go(goal);
    });
    row.append(b);
  }
}

el("clear").addEventListener("click", () => {
  goal = null;
  route = null;
  routeLayer.show(null);
  el("trip").hidden = true;
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

const km = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const minutes = (s: number) => (s < 3600 ? `${Math.round(s / 60)}분` : `${Math.floor(s / 3600)}시간 ${Math.round((s % 3600) / 60)}분`);

// ---- probes and replay -----------------------------------------------------

el("beep").addEventListener("click", async () => {
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

map.on("load", async () => {
  log(`UA ${navigator.userAgent}`);
  log(`secure=${window.isSecureContext} style=${style}`);
  el("wake").textContent = await keepAwake();
  gps.start();
  try {
    health = await api.health();
    provider = (["tmap", "kakao", "naver"] as Provider[]).find((p) => health!.providers[p]) ?? provider;
    log(`서버 ${JSON.stringify(health)}`);
    if (!health.search) el<HTMLInputElement>("q").placeholder = "검색 키 없음 — lon,lat 입력";
  } catch {
    log("서버 응답 없음 (/api/health)");
  }
});
