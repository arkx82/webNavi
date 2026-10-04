import { Lockout, clientIp } from "./guard.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import { EDITABLE, type SecretName, type Settings } from "./settings.js";

/**
 * The page where the keys go in. Two ways in: the page's own password
 * (the built-in 관리자 "admin", set on the first visit; a session cookie
 * signed with the master key; five wrong tries lock an address out for a
 * minute) — or a site account whose role is 관리자, by its own login on the
 * car page, with nothing more to type. The keys never come back out — the
 * page is shown whether each is set and its last four characters.
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

export function registerAdmin(
  app: FastifyInstance, settings: Settings, checks: AdminChecks, pageFile: string,
  /** The site account the request is logged in as, where its role is 관리자; null otherwise. */
  adminUser: (request: FastifyRequest) => string | null = () => null,
  /** Whether any site account is 관리자: then the page's password is set by one of them, not by whoever comes first. */
  anyAdmin: () => boolean = () => false,
): { adminGuard: Guard } {
  // Wrong logins by address and, under one key, for the page as a whole: a forged address does not start afresh (guard.ts).
  const lockout = new Lockout(LOCK_AFTER, LOCK_MS);

  const isSecure = (request: FastifyRequest) =>
    request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";

  const loggedIn = (request: FastifyRequest): boolean => byPassword(request) || adminUser(request) != null;
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

  const guard = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!loggedIn(request)) return reply.code(401).send({ error: "login" });
    // JSON calls from the page carry this; a form posted cross-site cannot.
    if (request.method !== "GET" && request.headers["x-requested-with"] !== "nav-admin") {
      return reply.code(403).send({ error: "origin" });
    }
  };

  app.get("/admin", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(readFileSync(pageFile, "utf8"));
  });

  app.get("/admin/api/state", async (request) => {
    const user = adminUser(request);
    // An admin account is let in before the page's password is set too: setting it is then the account's to do.
    return {
      needsSetup: !settings.hasPassword && !user && !anyAdmin(),
      loggedIn: (settings.hasPassword && byPassword(request)) || user != null,
      who: byPassword(request) ? "admin" : user,
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

  app.post<{ Body: { password?: string } }>("/admin/api/login", async (request, reply) => {
    const who = clientIp(request);
    const keys = [`ip:${who}`, "admin"];
    const wait = lockout.wait(keys);
    if (wait) return reply.code(429).send({ error: `잠김 — ${wait}초 뒤` });
    if (!settings.checkPassword(request.body?.password ?? "")) {
      lockout.failed(keys);
      request.log.warn({ who }, "admin login failed");
      return reply.code(401).send({ error: "비밀번호가 다릅니다" });
    }
    lockout.passed(keys);
    setSession(request, reply);
    return { ok: true };
  });

  app.post("/admin/api/logout", async (request, reply) => {
    reply.header("Set-Cookie", `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(request) ? "; Secure" : ""}`);
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

  return { adminGuard: guard };
}
