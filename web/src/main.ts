import maplibregl from "maplibre-gl";
import { Gps, type Fix } from "./gps";
import { chime, keepAwake } from "./probes";

// A key-free vector style; swap for a Mapbox/VWorld style URL through
// VITE_MAP_STYLE once Korean coverage has been compared in the car.
const style = import.meta.env.VITE_MAP_STYLE ?? "https://tiles.openfreemap.org/styles/liberty";

const map = new maplibregl.Map({
  container: "map",
  style,
  center: [127.0276, 37.4979],
  zoom: 15,
  pitch: 45,
  attributionControl: false,
});

const el = (id: string) => document.getElementById(id)!;
const lines: string[] = [];
function log(text: string) {
  lines.push(`${new Date().toLocaleTimeString("ko-KR", { hour12: false })} ${text}`);
  if (lines.length > 200) lines.shift();
  el("log").textContent = lines.join("\n");
  el("log").scrollTop = el("log").scrollHeight;
}

// The car, as a dot with a nose; heading rotates the map, not the dot.
const dot = document.createElement("div");
dot.style.cssText = "width:18px;height:18px;border-radius:50%;background:#4fc3f7;border:3px solid #fff;box-shadow:0 0 8px #000";
const marker = new maplibregl.Marker({ element: dot }).setLngLat([127.0276, 37.4979]);

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
    map.easeTo({
      center: [fix.lon, fix.lat],
      bearing: fix.course ?? map.getBearing(),
      duration: 900,
      easing: (t) => t,
    });
  }
}

el("follow").addEventListener("click", () => {
  follow = !follow;
  el("follow").classList.toggle("on", follow);
});
map.on("dragstart", () => {
  follow = false;
  el("follow").classList.remove("on");
});
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

map.on("load", async () => {
  log(`UA ${navigator.userAgent}`);
  log(`secure=${window.isSecureContext} style=${style}`);
  el("wake").textContent = await keepAwake();
  gps.start();
  try {
    const health = await (await fetch("/api/health")).json();
    log(`서버 ${JSON.stringify(health)}`);
  } catch {
    log("서버 응답 없음 (/api/health)");
  }
});
