/**
 * A new version of the page, loaded by itself: a car's page stays open for days (a tester's ran 2,889 minutes,
 * 2026-10-25..27, and the fixes deployed meanwhile never reached it). The server says which page it hands out now
 * (/api/version, its main script's hashed name); one other than this page's is a new version, and the page is
 * reloaded once nothing is going on — no drive, the car still, the screen not touched — so no warning or turn is
 * cut off. A drive the page was in would come back (resume.ts) but its voice can wait for a tap, so none is.
 */

/** Asked this often; and when the page is shown again. */
export const VERSION_EVERY_MS = 5 * 60_000;
/** Still (no speed) and untouched this long, the page may be reloaded: longer than a long red light (안전운전 has no route). */
export const RELOAD_STILL_MS = 5 * 60_000;
export const RELOAD_UNTOUCHED_MS = 60_000;

/** This page's version: its main script's name, as the server gives it; null in development (no hashed script). */
export function ownVersion(): string | null {
  const s = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/main-"]');
  return s ? /\/assets\/(main-[^/?#]+\.js)/.exec(s.src)?.[1] ?? null : null;
}

export interface Quiet {
  /** A drive (a route, a pretend drive, the demo) is on. */
  driving: boolean;
  /** How long the car has had no speed (no fix at all, the car asleep, counts as none). */
  stillMs: number;
  /** Since the screen was last touched. */
  untouchedMs: number;
  /** The voice is saying something. */
  speaking: boolean;
}

/** Whether a page with a new version waiting may be reloaded now. */
export function quietEnough(q: Quiet): boolean {
  return !q.driving && !q.speaking && q.stillMs >= RELOAD_STILL_MS && q.untouchedMs >= RELOAD_UNTOUCHED_MS;
}

/**
 * Watches for a new version and reloads into it when [quiet] says so. [log] is told once when one is found, and
 * just before the reload.
 */
export function watchVersion(quiet: () => Quiet, log: (line: string) => void) {
  const own = ownVersion();
  if (!own) return;
  let found: string | null = null;
  const ask = async () => {
    try {
      const r = await fetch("/api/version", { cache: "no-store" });
      if (!r.ok) return;
      const { web } = (await r.json()) as { web: string | null };
      if (web && web !== own && web !== found) {
        found = web;
        log(`새 버전 ${web} (지금 ${own}) — 운행이 없고 차가 서 있을 때 새로 고침`);
      }
    } catch { /* offline: asked again later */ }
  };
  void ask();
  setInterval(() => void ask(), VERSION_EVERY_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void ask(); });
  setInterval(() => {
    if (!found || !quietEnough(quiet())) return;
    log(`새 버전으로 새로 고침 ${found}`);
    found = null;
    // A moment for the line to be sent with the rest (the log goes out in batches).
    setTimeout(() => location.reload(), 1500);
  }, 10_000);
}
