/**
 * What a user keeps on the server (server/src/db.ts) — 집 · 회사 · 즐겨찾기,
 * recent places, 안내 설정 — mirrored into this browser's storage before the
 * app starts, so the app reads and writes its storage as it always has and
 * each save is sent on. The server's copy wins on load, except a change made
 * here that never reached the server (offline, the page closed too soon): that
 * is sent up instead. The browser's is sent up the first time a user logs in
 * on a device that already had some.
 */
export type UserKey = "places" | "recents" | "guide" | "drive";
export const STORAGE: Record<UserKey, string> = { places: "nav-places", recents: "nav-recent", guide: "nav-guide", drive: "nav-drive" };
const WHO = "nav-user";
/** Set while a key's change is not on the server yet: the time it was changed. */
const dirtyKey = (key: UserKey) => `nav-dirty-${key}`;
/** A save is sent this long after the last change (a slider moves many times a second). */
const SETTLE_MS = 800;

export interface Me {
  id: number;
  name: string;
}

let me: Me | null = null;
export const currentUser = () => me;

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => {
  try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window */ }
};
/** Storage's value for [key], or undefined when there is none or it is not JSON (a corrupt one is dropped, not thrown over). */
const local = (key: UserKey): unknown => {
  const s = read(STORAGE[key]);
  if (s == null) return undefined;
  try { return JSON.parse(s); } catch { write(STORAGE[key], null); write(dirtyKey(key), null); return undefined; }
};

export type Merge = "server" | "push" | "keep";
/**
 * Which copy a key keeps on login. A local change the server has not got yet
 * goes up (the server's copy is older); else the server's comes down; else
 * what this device had before logins is uploaded, when it is this user's.
 */
/**
 * The drive in progress is merged by time, not by who changed it last: the
 * copy written latest (a drive still going, or an ending) wins, whether it
 * sits on the server or here. A device that ended its drive but could not
 * tell the server (a 502 while it was redeployed) must not, on its next
 * start, push that stale ending over a drive another device is still on.
 */
export function pickDrive(server: unknown, local: unknown, mayUpload: boolean): Merge {
  const at = (v: unknown) => (v && typeof v === "object" ? Number((v as { at?: number }).at ?? (v as { endedAt?: number }).endedAt ?? 0) : 0);
  const s = at(server), l = at(local);
  if (server !== undefined && s >= l) return "server";
  if (local !== undefined && mayUpload) return "push";
  return server !== undefined ? "server" : "keep";
}

export function merge(s: { server: boolean; local: boolean; dirty: boolean; mayUpload: boolean }): Merge {
  if (s.local && s.dirty && s.mayUpload) return "push";
  if (s.server) return "server";
  if (s.local && s.mayUpload) return "push";
  return "keep";
}

/** Brings the server's copy into storage; a different user than last time starts from nothing local. */
export async function pull(user: Me) {
  me = user;
  const before = read(WHO);
  const sameUser = before === String(user.id);
  // Storage from before logins existed belongs to whoever logs in first; another user's does not.
  const mayUpload = sameUser || before == null;
  if (!sameUser && before != null) for (const key of Object.keys(STORAGE) as UserKey[]) { write(STORAGE[key], null); write(dirtyKey(key), null); }
  write(WHO, String(user.id));
  const a = await fetch("/api/me/data");
  if (!a.ok) return;
  const kept = (await a.json()) as Partial<Record<UserKey, { value: unknown }>>;
  for (const key of Object.keys(STORAGE) as UserKey[]) {
    const server = kept[key], mine = local(key);
    const choice = key === "drive" ? pickDrive(server ? server.value : undefined, mine, mayUpload) : merge({ server: !!server, local: mine !== undefined, dirty: read(dirtyKey(key)) != null, mayUpload });
    switch (choice) {
      case "server": write(STORAGE[key], JSON.stringify(server!.value)); write(dirtyKey(key), null); break;
      case "push": push(key, mine); break;
    }
  }
}

/** How long a failed send waits before the next try: 2 s, 4 s, 8 s … up to a minute. */
export function retryAfterMs(failures: number): number {
  return Math.min(60_000, 2000 * 2 ** Math.max(0, failures - 1));
}

const timers = new Map<UserKey, ReturnType<typeof setTimeout>>();
/** What is to be sent, the latest value a key; taken out once the server has it. */
const pending = new Map<UserKey, unknown>();
const failures = new Map<UserKey, number>();

/** Sends [value] to the server a moment after the last change; marked unsent in storage until the server has it. */
export function push(key: UserKey, value: unknown) {
  if (!me) return;
  pending.set(key, value);
  write(dirtyKey(key), String(Date.now()));
  later(key, SETTLE_MS);
}

function later(key: UserKey, ms: number) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => void send(key), ms));
}

/** One PUT of the key's latest value; a miss (offline) tries again later, with growing gaps. */
async function send(key: UserKey, keepalive = false) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  if (!pending.has(key)) return;
  const value = pending.get(key);
  try {
    const a = await fetch(`/api/me/data/${key}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }), keepalive });
    if (!a.ok) throw new Error(`${a.status}`);
    failures.delete(key);
    // A newer change came while this one was on its way: it is still pending, its own send follows.
    if (pending.get(key) === value) { pending.delete(key); write(dirtyKey(key), null); }
  } catch {
    const n = (failures.get(key) ?? 0) + 1;
    failures.set(key, n);
    if (!timers.has(key)) later(key, retryAfterMs(n));
  }
}

/** The page going away or to the background: whatever waits is sent now, and lives on past the page (keepalive). */
export function flush() {
  for (const key of [...pending.keys()]) void send(key, true);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  window.addEventListener("pagehide", flush);
}

export async function logout() {
  flush();
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.reload();
}
