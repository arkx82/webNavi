import { Lockout, clientIp, isApiPath } from "./guard.js";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { USER_KEYS, type Db, type User, type UserKey } from "./db.js";
import type { Settings } from "./settings.js";

/**
 * The car page's lock. Every /api call needs a user — the site faces the
 * internet through the tunnel, and each route, search and sentence is paid
 * for with the owner's keys — so a signed cookie names the user, made by
 * /api/login and kept a year (a car should not be asked again every week).
 * Users are made on /admin; a password changed there ends the old sessions.
 */
const COOKIE = "nav_user";
const SESSION_DAYS = 365;
const LOCK_AFTER = 5;
const LOCK_MS = 60_000;

/**
 * What needs no user: logging in, and the page's question whether it is;
 * and what /admin reads (its cookie is for /admin only) — whether a music
 * account is connected, a yes or no each. The music player's own calls
 * (the token, the audio, the TIDAL proxy) are same-origin and carry the
 * session cookie, so they are gated like everything else.
 */
/** The site's key for the 안내 설정 defaults. */
const GUIDE_DEFAULTS = "guideDefaults";
/** An account's 안내 설정 as the site's defaults: not the device's own (차량 데이터), nor the account's bookkeeping. */
export function guideDefaultsOf(guide: Record<string, unknown>): Record<string, unknown> {
  const { carData: _car, own: _own, rev, from: _from, ...rest } = guide;
  // As the account's own page reads them (web/src/guide-settings.ts migrate): a copy saved before a revision is
  // changed the same way here, or an account starting from it would get what its owner no longer sees.
  const r = typeof rev === "number" ? rev : 1;
  if (rest.fasterRoute === "auto") rest.fasterRoute = "ask";
  if (r < 3 && rest.curves === "show") rest.curves = "off";
  if (r < 4 && rest.carIcon === "tesla") rest.carIcon = "model3d";
  return rest;
}

const OPEN = new Set(["/api/login", "/api/logout", "/api/me", "/api/music/state"]);
/** Loaded by <script> tags before any login: an empty script rather than a refusal. */
const SCRIPTS = new Set(["/api/map/tmap.js", "/api/map/naver.js"]);

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

/** The session cookie's body and signature, or null where there is none or it is not even well-formed. */
export function parseSession(cookieHeader: string | undefined): [body: string, sig: string] | null {
  const m = (cookieHeader ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  let raw: string;
  try { raw = decodeURIComponent(m[1]); } catch { return null; }
  const [body, sig] = raw.split("~");
  return body && sig ? [body, sig] : null;
}

/** The site user a request's session cookie names, if it is good (signed, not expired, the password not changed since). */
export function sessionUser(request: FastifyRequest, db: Db, settings: Settings): User | null {
  const session = parseSession(request.headers.cookie);
  if (!session) return null;
  const [body, sig] = session;
  if (!settings.verify(`user:${body}`, sig)) return null;
  const [id, epoch, exp] = body.split(".").map(Number);
  if (!(exp > Date.now())) return null;
  return db.session(id, epoch);
}

const isSecure = (request: FastifyRequest) => request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
const cookie = (request: FastifyRequest, value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(request) ? "; Secure" : ""}`;

/** Logs [user] in on this browser for a year: the car page's session, which /admin takes too. */
export function issueSession(request: FastifyRequest, reply: FastifyReply, user: User & { epoch: number }, settings: Settings) {
  const body = `${user.id}.${user.epoch}.${Date.now() + SESSION_DAYS * 86_400_000}`;
  reply.header("Set-Cookie", cookie(request, encodeURIComponent(`${body}~${settings.sign(`user:${body}`)}`), SESSION_DAYS * 86_400));
}
export function endSession(request: FastifyRequest, reply: FastifyReply) {
  reply.header("Set-Cookie", cookie(request, "", 0));
}

export function registerUsers(
  app: FastifyInstance, db: Db, settings: Settings,
  adminGuard: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>, workDir: string,
  /** Anyone logged in to /admin, for what an account changes of its own. */
  selfGuard: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> = adminGuard,
  /** An account deleted: its Tesla and TIDAL links go with it (car/, music.ts forget). */
  onRemoved: (name: string) => void = () => {},
) {
  // Wrong logins by address and by account: a forged address does not free the account (guard.ts).
  const lockout = new Lockout(LOCK_AFTER, LOCK_MS);

  const userOf = (request: FastifyRequest): User | null => sessionUser(request, db, settings);

  app.decorateRequest("user", null);
  /** Last-seen is written at most this often per user. */
  const seenAt = new Map<number, number>();
  app.addHook("onRequest", async (request, reply) => {
    if (!isApiPath(request.url)) return;
    let path = request.url.split("?")[0];
    try { path = decodeURIComponent(path); } catch { /* refused below as not open */ }
    request.user = userOf(request);
    if (request.user) {
      const last = seenAt.get(request.user.id) ?? 0;
      if (Date.now() - last > 5 * 60_000) { seenAt.set(request.user.id, Date.now()); db.seen(request.user.id); }
      return;
    }
    if (OPEN.has(path)) return;
    if (SCRIPTS.has(path)) return reply.type("text/javascript; charset=utf-8").header("Cache-Control", "no-store").send("/* not logged in */");
    return reply.code(401).send({ error: "login" });
  });

  app.post<{ Body: { name?: string; password?: string } }>("/api/login", async (request, reply) => {
    // A body of the wrong shape (a number for a name) is a bad request, not a crash in trim() or scrypt.
    if (request.body != null && (typeof request.body !== "object" || Array.isArray(request.body))) return reply.code(400).send({ error: "body" });
    const name = request.body?.name, password = request.body?.password;
    if ((name != null && typeof name !== "string") || (password != null && typeof password !== "string")) return reply.code(400).send({ error: "body" });
    const who = clientIp(request);
    const keys = [`ip:${who}`, `name:${(request.body?.name ?? "").trim().toLowerCase()}`];
    const wait = lockout.wait(keys);
    if (wait) return reply.code(429).send({ error: `잠시 잠김 — ${wait}초 뒤에 다시` });
    const user = db.check(request.body?.name ?? "", request.body?.password ?? "");
    if (!user) {
      lockout.failed(keys);
      request.log.warn({ who, name: request.body?.name }, "login failed");
      return reply.code(401).send({ error: "아이디 또는 비밀번호가 다릅니다" });
    }
    lockout.passed(keys);
    issueSession(request, reply, user, settings);
    request.log.info({ user: user.name }, "logged in");
    return { user: { id: user.id, name: user.name } };
  });

  app.post("/api/logout", async (request, reply) => {
    endSession(request, reply);
    return { ok: true };
  });

  app.get("/api/me", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "login", users: db.users().length > 0 });
    return { user: { id: request.user.id, name: request.user.name, role: request.user.role } };
  });

  // What the user keeps, all at once (the page loads it before it starts) and one key at a time.
  // With the site's 안내 설정 defaults beside them: what an account has not set itself comes from those.
  app.get("/api/me/data", async (request) => {
    const defaults = db.site(GUIDE_DEFAULTS);
    return { ...db.data(request.user!.id), ...(defaults ? { guideDefaults: defaults } : {}) };
  });
  app.put<{ Params: { key: string }; Body: { value?: unknown } }>("/api/me/data/:key", async (request, reply) => {
    const key = request.params.key as UserKey;
    if (!USER_KEYS.includes(key)) return reply.code(400).send({ error: `key is one of ${USER_KEYS.join(",")}` });
    if (request.body?.value === undefined) return reply.code(400).send({ error: "value" });
    if (JSON.stringify(request.body.value).length > 200_000) return reply.code(413).send({ error: "too large" });
    return { updated: db.setData(request.user!.id, key, request.body.value) };
  });

  // The page's 진단 log, a file a user a day under WORK_DIR/client-logs, so a drive can be looked at afterwards.
  const LOG_DAY_MAX = 5_000_000;
  const logDir = join(workDir, "client-logs");
  /** Made once, on the first log; made again only if that failed. */
  let logDirMade: Promise<unknown> | null = null;
  // Beside it the drive's trace (web/src/drive-trace.ts: fixes, the car's samples, the marker drawn, the routes), the
  // same name with .trace, to be played again at a desk (tools/replay-trace.ts).
  const TRACE_DAY_MAX = 40_000_000;
  // A post with a route or two in its trace runs past Fastify's 1 MiB.
  app.post<{ Body: { lines?: unknown; trace?: unknown } }>("/api/me/log", { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    const strings = (v: unknown, most: number) => (Array.isArray(v) ? v.filter((l): l is string => typeof l === "string").slice(0, most) : []);
    const lines = strings(request.body?.lines, 2000);
    const trace = strings(request.body?.trace, 20_000);
    if (!lines.length && !trace.length) return { ok: true };
    try {
      await (logDirMade ??= mkdir(logDir, { recursive: true }));
    } catch (e) {
      logDirMade = null;
      throw e;
    }
    const base = join(logDir, `${request.user!.name.replace(/[^\p{L}\p{N}._-]/gu, "_")}-${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)}`);
    const add = async (file: string, rows: string[], most: number, longest: number) => {
      const size = await stat(file).then((s) => s.size, () => 0);
      if (size > most) return false;
      await appendFile(file, rows.map((l) => l.replace(/[\r\n]+/g, " ").slice(0, longest)).join("\n") + "\n");
      return true;
    };
    const logged = !lines.length || (await add(`${base}.log`, lines, LOG_DAY_MAX, 1000));
    // A route is a line of its own, its whole path: up to a long drive's.
    if (trace.length) await add(`${base}.trace`, trace, TRACE_DAY_MAX, 600_000);
    if (!logged) return reply.code(413).send({ error: "today's log is full" });
    return { ok: true };
  });

  // The browser's own reports (the Reporting API): above all "crash", sent by Chrome on the next start after the
  // page's process died — the sad tab that took the car's page three times (2026-10-04 twice, 10-09) with nothing in
  // the log. The page's crash context (window.crashReport, main.ts) comes in it: its last memory line and log lines.
  // Asked for by the Reporting-Endpoints header on every page (index.ts); the session cookie comes with it.
  app.addContentTypeParser("application/reports+json", { parseAs: "string", bodyLimit: 512 * 1024 }, (_request, body, done) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error, undefined); }
  });
  app.post("/api/report", async (request, reply) => {
    const reports = Array.isArray(request.body) ? (request.body as { type?: unknown; url?: unknown; age?: unknown; body?: unknown }[]).slice(0, 20) : [];
    if (!reports.length) return reply.code(204).send();
    await (logDirMade ??= mkdir(logDir, { recursive: true }));
    const now = new Date();
    const file = join(logDir, `${request.user!.name.replace(/[^\p{L}\p{N}._-]/gu, "_")}-${new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10)}.log`);
    const lines = reports.map((r) => {
      const url = String(r.url ?? "").replace(/^https?:\/\/[^/]+/, "");
      // The context's log is many lines in one value: kept whole, on this one line, to be split when read.
      return `${now.toISOString()} 브라우저 보고 ${String(r.type ?? "?")} ${url} ${Math.round(Number(r.age) || 0)}ms 전 ${JSON.stringify(r.body ?? null).replace(/[\r\n]+/g, " ").slice(0, 70_000)}`;
    });
    await appendFile(file, lines.join("\n") + "\n");
    request.log.warn({ types: reports.map((r) => r.type) }, "browser report");
    return reply.code(204).send();
  });

  // /admin: an account's own password, the old one asked first. The account's other devices log in again (the epoch
  // moves on); this browser is given a new session at once. The built-in admin's is the page's, under 설정.
  app.post<{ Body: { current?: unknown; password?: unknown } }>("/admin/api/me/password", { preHandler: selfGuard }, async (request, reply) => {
    const me = userOf(request);
    if (!me) return reply.code(400).send({ error: "관리 페이지 비밀번호는 위 설정에서 바꿉니다" });
    const current = typeof request.body?.current === "string" ? request.body.current : "";
    const next = typeof request.body?.password === "string" ? request.body.password : "";
    const keys = [`ip:${clientIp(request)}`, `name:${me.name.toLowerCase()}`];
    const wait = lockout.wait(keys);
    if (wait) return reply.code(429).send({ error: `잠시 잠김 — ${wait}초 뒤에 다시` });
    if (!db.check(me.name, current)) {
      lockout.failed(keys);
      return reply.code(401).send({ error: "지금 비밀번호가 다릅니다" });
    }
    lockout.passed(keys);
    try {
      db.setPassword(me.id, next);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const fresh = db.check(me.name, next);
    if (fresh) issueSession(request, reply, fresh, settings);
    request.log.info({ user: me.name }, "own password changed");
    return { ok: true };
  });

  // 지금 운행 중: each account's car page says every 30 s how it is (main.ts sendPresence) — the speed shown, guided
  // or not and the time left, a pretend drive; never where. Kept in memory: a restart forgets, the next word brings it.
  const presence = new Map<number, Presence>();
  app.post<{ Body: { kmh?: unknown; guiding?: unknown; sim?: unknown; leftS?: unknown; gone?: unknown } }>("/api/me/presence", async (request) => {
    const b = request.body ?? {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    presence.set(request.user!.id, b.gone === true
      ? { at: Date.now(), gone: true, kmh: null, guiding: false, sim: false, leftS: null }
      : { at: Date.now(), gone: false, kmh: num(b.kmh), guiding: b.guiding === true, sim: b.sim === true, leftS: num(b.leftS) });
    return { ok: true };
  });

  // /admin: the users, each with how its car page is now (presenceWord).
  app.get("/admin/api/users", { preHandler: adminGuard }, async () => ({
    users: db.users().map((u) => ({ ...u, now: presenceWord(presence.get(u.id), u.lastSeen) })),
  }));
  app.post<{ Body: { name?: string; password?: string } }>("/admin/api/users", { preHandler: adminGuard }, async (request, reply) => {
    try {
      const user = db.addUser(request.body?.name ?? "", request.body?.password ?? "");
      request.log.info({ user: user.name }, "user added");
      return { user, users: db.users() };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.post<{ Params: { id: string }; Body: { password?: string } }>("/admin/api/users/:id/password", { preHandler: adminGuard }, async (request, reply) => {
    try {
      db.setPassword(Number(request.params.id), request.body?.password ?? "");
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  // The 안내 설정 every account starts from: an account's own, as it has them now (what each account sets itself stays its own).
  app.get("/admin/api/guide-defaults", { preHandler: adminGuard }, async () => {
    const d = db.site(GUIDE_DEFAULTS);
    return d ? { from: (d.value as { from?: string }).from ?? null, updated: d.updated } : { from: null, updated: null };
  });
  app.post<{ Body: { user?: string } }>("/admin/api/guide-defaults", { preHandler: adminGuard }, async (request, reply) => {
    const name = String(request.body?.user ?? "").trim().toLowerCase();
    const user = db.users().find((u) => u.name.toLowerCase() === name);
    if (!user) return reply.code(400).send({ error: "계정을 고르세요" });
    const guide = db.data(user.id).guide?.value;
    if (!guide || typeof guide !== "object") return reply.code(400).send({ error: `${user.name} 계정에 저장된 안내 설정이 없습니다` });
    const settings = guideDefaultsOf(guide as Record<string, unknown>);
    const updated = db.setSite(GUIDE_DEFAULTS, { ...settings, from: user.name });
    return { from: user.name, updated, keys: Object.keys(settings).length };
  });

  app.post<{ Params: { id: string }; Body: { role?: string } }>("/admin/api/users/:id/role", { preHandler: adminGuard }, async (request, reply) => {
    const role = request.body?.role;
    if (role !== "admin" && role !== "user") return reply.code(400).send({ error: "role: admin 또는 user" });
    db.setRole(Number(request.params.id), role);
    return { users: db.users() };
  });
  app.delete<{ Params: { id: string } }>("/admin/api/users/:id", { preHandler: adminGuard }, async (request) => {
    const gone = db.users().find((u) => u.id === Number(request.params.id));
    db.removeUser(Number(request.params.id));
    if (gone) {
      try { onRemoved(gone.name); } catch (e) { request.log.warn({ err: (e as Error).message, user: gone.name }, "links of a removed user"); }
      request.log.info({ user: gone.name }, "user removed");
    }
    return { users: db.users() };
  });
}

interface Presence { at: number; gone: boolean; kmh: number | null; guiding: boolean; sim: boolean; leftS: number | null }
/** A car page not heard from in this long is taken as closed (it speaks every 30 s). */
const PRESENCE_STALE_MS = 90_000;
/** Moving at this or more is 운행 중; under it, guided, 정차 중 (a light, a jam). */
const MOVING_KMH = 3;

/** How an account's car page is now, in a few words, and whether it is out on the road: for /admin's 지금 운행 중. */
export function presenceWord(p: Presence | undefined, lastSeen: number | null, now = Date.now()): { state: "driving" | "stopped" | "open" | "off"; text: string } {
  const ago = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : s < 86_400 ? `${Math.round(s / 3600)}시간 전` : `${Math.round(s / 86_400)}일 전`; };
  if (!p || p.gone || now - p.at > PRESENCE_STALE_MS) {
    const last = Math.max(p?.at ?? 0, lastSeen ?? 0);
    return { state: "off", text: last ? `꺼짐 · 마지막 접속 ${ago(now - last)}` : "접속한 적 없음" };
  }
  const kmh = p.kmh ?? 0;
  const left = p.guiding && p.leftS != null ? ` · 도착까지 ${p.leftS < 3600 ? `${Math.max(1, Math.round(p.leftS / 60))}분` : `${Math.floor(p.leftS / 3600)}시간 ${Math.round((p.leftS % 3600) / 60)}분`}` : "";
  const what = p.sim ? "모의 주행" : p.guiding ? "안내 중" : "";
  if (kmh >= MOVING_KMH) return { state: "driving", text: [p.sim ? "모의 주행 중" : "운행 중", `${Math.round(kmh)} km/h`, !p.sim && p.guiding ? "안내 중" : ""].filter(Boolean).join(" · ") + left };
  if (p.guiding || p.sim) return { state: "stopped", text: `정차 중 · ${what}${left}` };
  return { state: "open", text: "화면 켜짐 · 정지" };
}
