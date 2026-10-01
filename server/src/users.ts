import { Lockout, clientIp } from "./guard.js";
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

export function registerUsers(app: FastifyInstance, db: Db, settings: Settings, adminGuard: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>, workDir: string) {
  // Wrong logins by address and by account: a forged address does not free the account (guard.ts).
  const lockout = new Lockout(LOCK_AFTER, LOCK_MS);
  const isSecure = (request: FastifyRequest) => request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";

  const userOf = (request: FastifyRequest): User | null => {
    const session = parseSession(request.headers.cookie);
    if (!session) return null;
    const [body, sig] = session;
    if (!settings.verify(`user:${body}`, sig)) return null;
    const [id, epoch, exp] = body.split(".").map(Number);
    if (!(exp > Date.now())) return null;
    return db.session(id, epoch);
  };

  const cookie = (request: FastifyRequest, value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(request) ? "; Secure" : ""}`;

  app.decorateRequest("user", null);
  /** Last-seen is written at most this often per user. */
  const seenAt = new Map<number, number>();
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (!path.startsWith("/api/")) return;
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
    const body = `${user.id}.${user.epoch}.${Date.now() + SESSION_DAYS * 86_400_000}`;
    reply.header("Set-Cookie", cookie(request, encodeURIComponent(`${body}~${settings.sign(`user:${body}`)}`), SESSION_DAYS * 86_400));
    request.log.info({ user: user.name }, "logged in");
    return { user: { id: user.id, name: user.name } };
  });

  app.post("/api/logout", async (request, reply) => {
    reply.header("Set-Cookie", cookie(request, "", 0));
    return { ok: true };
  });

  app.get("/api/me", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "login", users: db.users().length > 0 });
    return { user: { id: request.user.id, name: request.user.name } };
  });

  // What the user keeps, all at once (the page loads it before it starts) and one key at a time.
  app.get("/api/me/data", async (request) => db.data(request.user!.id));
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
  app.post<{ Body: { lines?: unknown } }>("/api/me/log", async (request, reply) => {
    const lines = Array.isArray(request.body?.lines) ? request.body!.lines.filter((l): l is string => typeof l === "string").slice(0, 2000) : [];
    if (!lines.length) return { ok: true };
    try {
      await (logDirMade ??= mkdir(logDir, { recursive: true }));
    } catch (e) {
      logDirMade = null;
      throw e;
    }
    const file = join(logDir, `${request.user!.name.replace(/[^\p{L}\p{N}._-]/gu, "_")}-${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)}.log`);
    const size = await stat(file).then((s) => s.size, () => 0);
    if (size > LOG_DAY_MAX) return reply.code(413).send({ error: "today's log is full" });
    await appendFile(file, lines.map((l) => l.replace(/[\r\n]+/g, " ").slice(0, 1000)).join("\n") + "\n");
    return { ok: true };
  });

  // /admin: the users.
  app.get("/admin/api/users", { preHandler: adminGuard }, async () => ({ users: db.users() }));
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
  app.delete<{ Params: { id: string } }>("/admin/api/users/:id", { preHandler: adminGuard }, async (request) => {
    db.removeUser(Number(request.params.id));
    return { users: db.users() };
  });
}
