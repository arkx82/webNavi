import { Lockout, clientIp } from "./guard.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import { EDITABLE, type SecretName, type Settings } from "./settings.js";
import type { Db } from "./db.js";
import { endSession, issueSession, sessionUser } from "./users.js";

/**
 * The page where the keys go in, and where each account links its own Tesla and TIDAL. In by an account's 아이디 and
 * 비밀번호 (the car page's login, the same session: a browser logged in there is in here with nothing more to type),
 * or as "admin" with the page's own password (the built-in 관리자, set on the first visit while no account is 관리자;
 * a session cookie signed with the master key). Five wrong tries lock an address out for a minute.
 *
 * A 관리자 sees and changes everything of the site's. A 사용자 sees only what is theirs to set — their own Tesla and
 * TIDAL links and their password. The links are each account's own, a 관리자's too: anyone links and unlinks their own
 * only (accountFor), and a 관리자 sees the others' as a line each, never a button.
 * The keys never come back out — the page is shown whether each is set and its last four characters.
 */
const SESSION_DAYS = 30;
const COOKIE = "nav_admin";
const LOCK_AFTER = 5;
const LOCK_MS = 60_000;

export interface AdminChecks {
  /** Tries each keyed service with one small real call; a word per service. */
  test(): Promise<Record<string, string>>;
  /** Renders the fixed phrases; how many were made and how many were there. */
  prerender(): Promise<{ made: number; had: number }>;
  status(): Record<string, unknown>;
}

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Who is on /admin: an account (관리자 or 사용자), or the built-in admin by the page's password. */
export interface AdminWho { name: string; admin: boolean; builtin: boolean }

export interface AdminAccess {
  /** 관리자 only: the keys, the users, the Fleet app, the tests. */
  adminGuard: Guard;
  /** Anyone logged in to /admin: what an account sets for itself. */
  selfGuard: Guard;
  isAdmin(request: FastifyRequest): boolean;
  /**
   * The account a link call acts for: the one logged in, 관리자 or 사용자, with none named or itself named — or null when
   * another is named, or for the built-in admin (no account of its own), to be refused.
   */
  accountFor(request: FastifyRequest, asked: unknown): string | null;
}

export function registerAdmin(app: FastifyInstance, settings: Settings, checks: AdminChecks, pageFile: string, db: Db): AdminAccess {
  /** Whether any site account is 관리자: then the page's password is set by one of them, not by whoever comes first. */
  const anyAdmin = () => db.users().some((u) => u.role === "admin");
  // Wrong logins by address and, under one key, for the page as a whole: a forged address does not start afresh (guard.ts).
  const lockout = new Lockout(LOCK_AFTER, LOCK_MS);

  const isSecure = (request: FastifyRequest) =>
    request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";

  const who = (request: FastifyRequest): AdminWho | null => {
    if (byPassword(request)) return { name: "admin", admin: true, builtin: true };
    const user = sessionUser(request, db, settings);
    return user ? { name: user.name, admin: user.role === "admin", builtin: false } : null;
  };
  /** The account logged in on the car page, where it is 관리자. */
  const adminUser = (request: FastifyRequest): string | null => {
    const w = who(request);
    return w && w.admin && !w.builtin ? w.name : null;
  };
  const byPassword = (request: FastifyRequest): boolean => {
    const raw = request.headers.cookie ?? "";
    const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    if (!m) return false;
    const [exp, sig] = m[1].split("~");
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    return settings.verify(exp, sig);
  };

  const setSession = (request: FastifyRequest, reply: FastifyReply) => {
    const exp = String(Date.now() + SESSION_DAYS * 86_400_000);
    const value = `${exp}~${settings.sign(exp)}`;
    reply.header("Set-Cookie", `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${isSecure(request) ? "; Secure" : ""}`);
  };

  const guardFor = (adminOnly: boolean): Guard => async (request, reply) => {
    const w = who(request);
    if (!w) return reply.code(401).send({ error: "login" });
    if (adminOnly && !w.admin) return reply.code(403).send({ error: "관리자만 할 수 있습니다" });
    // JSON calls from the page carry this; a form posted cross-site cannot.
    if (request.method !== "GET" && request.headers["x-requested-with"] !== "nav-admin") {
      return reply.code(403).send({ error: "origin" });
    }
  };
  const guard = guardFor(true);
  const selfGuard = guardFor(false);

  app.get("/admin", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(readFileSync(pageFile, "utf8"));
  });

  app.get("/admin/api/state", async (request) => {
    const w = who(request);
    // An account is let in before the page's password is set too: setting it is then a 관리자 account's to do.
    return {
      needsSetup: !settings.hasPassword && !w && !anyAdmin(),
      loggedIn: w != null,
      who: w?.name ?? null,
      admin: w?.admin ?? false,
      builtin: w?.builtin ?? false,
    };
  });

  app.post<{ Body: { password?: string } }>("/admin/api/setup", async (request, reply) => {
    if (settings.hasPassword) return reply.code(409).send({ error: "already set" });
    if (anyAdmin() && !adminUser(request)) return reply.code(403).send({ error: "관리자 계정으로 로그인한 뒤 정하세요" });
    const password = request.body?.password ?? "";
    if (password.length < 8) return reply.code(400).send({ error: "8자 이상" });
    settings.setPassword(password);
    setSession(request, reply);
    return { ok: true };
  });

  app.post<{ Body: { name?: unknown; password?: unknown } }>("/admin/api/login", async (request, reply) => {
    const ip = clientIp(request);
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    const keys = [`ip:${ip}`, `name:${name.toLowerCase() || "admin"}`];
    const wait = lockout.wait(keys);
    if (wait) return reply.code(429).send({ error: `잠김 — ${wait}초 뒤` });
    // An account by its own password: the car page's session, so that browser is logged in there too.
    const user = name ? db.check(name, password) : null;
    // "admin" (or no 아이디, as before) with the page's password, where no account is called that.
    const builtin = !user && (!name || (name.toLowerCase() === "admin" && !db.users().some((u) => u.name.toLowerCase() === "admin")))
      && settings.hasPassword && settings.checkPassword(password);
    if (!user && !builtin) {
      lockout.failed(keys);
      request.log.warn({ who: ip, name }, "admin login failed");
      return reply.code(401).send({ error: "아이디 또는 비밀번호가 다릅니다" });
    }
    lockout.passed(keys);
    if (user) {
      issueSession(request, reply, user, settings);
      request.log.info({ user: user.name, role: user.role }, "admin page login");
    } else setSession(request, reply);
    return { ok: true };
  });

  // Out of both: the page's own session and the account's (which is the car page's too, in this browser).
  app.post("/admin/api/logout", async (request, reply) => {
    reply.header("Set-Cookie", `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(request) ? "; Secure" : ""}`);
    endSession(request, reply);
    return { ok: true };
  });

  app.get("/admin/api/settings", { preHandler: guard }, async () => ({
    fields: settings.masked(),
    status: checks.status(),
  }));

  app.post<{ Body: Record<string, unknown> }>("/admin/api/settings", { preHandler: guard }, async (request, reply) => {
    const patch: Partial<Record<SecretName, string>> = {};
    for (const name of EDITABLE) {
      const v = request.body?.[name];
      if (typeof v === "string") patch[name] = v.trim();
    }
    if (typeof request.body?.password === "string" && request.body.password) {
      if ((request.body.password as string).length < 8) return reply.code(400).send({ error: "비밀번호는 8자 이상" });
      settings.setPassword(request.body.password as string);
    }
    settings.set(patch);
    request.log.info({ changed: Object.keys(patch) }, "settings saved");
    return { ok: true, fields: settings.masked() };
  });

  app.post("/admin/api/test", { preHandler: guard }, async () => checks.test());
  app.post("/admin/api/prerender", { preHandler: guard }, async () => checks.prerender());

  return {
    adminGuard: guard,
    selfGuard,
    isAdmin: (request) => who(request)?.admin ?? false,
    accountFor(request, asked) {
      const w = who(request);
      if (!w || w.builtin) return null;
      const name = typeof asked === "string" ? asked.trim() : "";
      return !name || name.toLowerCase() === w.name.toLowerCase() ? w.name : null;
    },
  };
}
