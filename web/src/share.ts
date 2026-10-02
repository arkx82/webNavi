import "./share.css";

/**
 * The phone's side of sending a place to the car: what 네이버 지도,
 * 카카오맵 or 티맵 shared (the share sheet's title, text and link, or a
 * paste), found again on the server (/api/share/resolve), sent to the
 * account chosen (/api/share/send) — whose car shows it at the top of
 * 목적지. Nothing here runs but while the page is open.
 */
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const TO_KEY = "share-to";

interface Place { name: string; address: string; at: [number, number] }
let found: Place | null = null;

async function post<T>(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const a = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: a.ok, status: a.status, data: (await a.json().catch(() => ({}))) as T };
}

async function start() {
  // The share sheet's way in: /share?title=…&text=…&url=…
  const q = new URLSearchParams(location.search);
  const shared = [q.get("title"), q.get("text"), q.get("url")].filter((v): v is string => !!v && v.trim() !== "");
  const text = [...new Set(shared)].join("\n");
  const who = await fetch("/api/share/users");
  if (who.status === 401) { showLogin(text); return; }
  const { me, users } = (await who.json()) as { me: string; users: string[] };
  $("login").hidden = true;
  $("send").hidden = false;
  const to = $<HTMLSelectElement>("to");
  let last: string | null = null;
  try { last = localStorage.getItem(TO_KEY); } catch { /* private window */ }
  for (const name of users) {
    const o = document.createElement("option");
    o.value = o.textContent = name;
    if (name === (last && users.includes(last) ? last : me)) o.selected = true;
    to.append(o);
  }
  if (text) { $<HTMLTextAreaElement>("text").value = text; void find(); }
}

function showLogin(text: string) {
  $("login").hidden = false;
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await post<{ error?: string }>("/api/login", { name: $<HTMLInputElement>("name").value, password: $<HTMLInputElement>("password").value });
    if (!r.ok) { $("login-msg").textContent = r.data.error ?? "로그인하지 못했어요"; return; }
    // The shared text kept across the reload.
    location.search = text ? `?text=${encodeURIComponent(text)}` : "";
  });
}

async function find() {
  const text = $<HTMLTextAreaElement>("text").value.trim();
  found = null;
  $<HTMLButtonElement>("go").disabled = true;
  $("place").hidden = true;
  if (!text) { $("msg").textContent = "공유받은 내용을 넣어 주세요"; return; }
  $("msg").textContent = "찾는 중…";
  const r = await post<{ place?: Place; error?: string }>("/api/share/resolve", { text });
  if (!r.ok || !r.data.place) { $("msg").textContent = r.data.error ?? "장소를 찾지 못했어요"; return; }
  found = r.data.place;
  $("place-name").textContent = found.name;
  $("place-addr").textContent = found.address;
  $("place").hidden = false;
  $("msg").textContent = "";
  $<HTMLButtonElement>("go").disabled = false;
}

$("find").addEventListener("click", () => void find());
$("go").addEventListener("click", async () => {
  if (!found) return;
  const to = $<HTMLSelectElement>("to").value;
  $<HTMLButtonElement>("go").disabled = true;
  const r = await post<{ to?: string; error?: string }>("/api/share/send", { to, place: found });
  if (!r.ok) { $("msg").textContent = r.data.error ?? "보내지 못했어요"; $<HTMLButtonElement>("go").disabled = false; return; }
  try { localStorage.setItem(TO_KEY, to); } catch { /* private window */ }
  $("msg").textContent = `${r.data.to} 계정으로 보냈어요. 차의 목적지 화면 맨 위에 나옵니다.`;
});

// Installable, so the share sheet lists it; the worker does nothing (no caching, no background work).
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/share-sw.js", { scope: "/share" }).catch(() => {});
void start();
