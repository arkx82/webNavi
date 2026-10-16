import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AdminAccess } from "../admin.js";
import { OWN_ONLY } from "../music.js";
import type { Db } from "../db.js";
import type { Settings } from "../settings.js";
import { FleetApi, FleetFeed, telemetryCa } from "./fleet.js";
import { CarHub, type CarSource, type LinkedCar } from "./hub.js";
import { OwnerAuth, OwnerStream } from "./owner.js";
import { FleetKey } from "./schnorr.js";

/**
 * The car's own speed for the page (web/src/car-track.ts): Tesla linked
 * on /admin, either way (owner.ts or fleet.ts), and each car page given
 * its car's samples as server-sent events on /api/car/stream.
 */

/** Where Tesla's Fleet login comes back to: the path registered with the app on developer.tesla.com. */
export const FLEET_CALLBACK = "/admin/car/tesla/callback";
export const PUBLIC_KEY_PATH = "/.well-known/appspecific/com.tesla.3p.public-key.pem";

export function registerCar(app: FastifyInstance, settings: Settings, db: Db, access: AdminAccess, configDir: string, workDir: string) {
  const { adminGuard, selfGuard } = access;
  const log = (m: string) => app.log.info(m);
  // Each site account's own Tesla login (owner.ts): an account sees the cars of the Tesla it linked, and none other.
  const tokens = (): Record<string, string> => { try { return JSON.parse(settings.get("teslaOwners") ?? "{}") as Record<string, string>; } catch { return {}; } };
  const owners = new Map<string, OwnerAuth>();
  const ownerFor = (user: string): OwnerAuth => {
    const key = user.trim().toLowerCase();
    let o = owners.get(key);
    if (!o) {
      o = new OwnerAuth({
        get: () => tokens()[key] || undefined,
        set: (token: string) => {
          const all = tokens();
          if (token) all[key] = token; else delete all[key];
          settings.set({ teslaOwners: JSON.stringify(all) });
        },
      });
      owners.set(key, o);
    }
    return o;
  };
  const accountOf = (name: unknown): string | null => {
    const n = String(name ?? "").trim().toLowerCase();
    return db.users().find((u) => u.name.toLowerCase() === n)?.name ?? null;
  };
  const key = new FleetKey(join(configDir, "tesla", "fleet-key.pem"));
  const fleet = new FleetApi(settings, key);
  const feed = new FleetFeed(process.env.FLEET_REDIS ?? "fleet-redis:6379", log);
  /** The chain the car is to trust for our fleet-telemetry server, kept beside the server's certificate. */
  const caFile = join(workDir, "telemetry", "ca.pem");

  const source = () => (settings.get("teslaSource") === "fleet" ? "fleet" : "owner");
  const cars = (): LinkedCar[] => {
    migrate();
    try { return JSON.parse(settings.get("teslaCars") ?? "[]") as LinkedCar[]; } catch { return []; }
  };
  /**
   * The one login of before (one Tesla account for the whole site, its car seen by every account whose name it was
   * not given) moved to an account: the one its cars were given to, else the first 관리자. Tried until there is one.
   */
  function migrate() {
    const old = settings.get("teslaRefresh");
    if (!old) return;
    let list: LinkedCar[] = [];
    try { list = JSON.parse(settings.get("teslaCars") ?? "[]") as LinkedCar[]; } catch { /* none */ }
    const who = list.find((c) => c.user)?.user ?? db.users().find((u) => u.role === "admin")?.name;
    if (!who) return;
    const all = tokens();
    all[who.toLowerCase()] ??= old;
    settings.set({ teslaOwners: JSON.stringify(all), teslaRefresh: "", teslaCars: JSON.stringify(list.map((c) => ({ ...c, user: c.user || who }))) });
    log(`Tesla 연결을 ${who} 계정으로 옮김`);
  }
  const hub = new CarHub(cars, (car, emit, state): CarSource | null => {
    if (source() === "fleet") return fleet.linked ? feed.source(car.vin, emit, state) : null;
    const owner = car.user ? ownerFor(car.user) : null;
    if (!owner?.linked || !car.vehicleId) return null;
    return new OwnerStream(car.vehicleId, owner, emit, state, (m) => app.log.info({ vin: car.vin.slice(-6), user: car.user }, m));
  });

  /**
   * The cars, as Tesla has them now. By the owner login, [user]'s own (those of every account linked, with none
   * named), each given to its account; by Fleet, the one app login's, each with the account it was given on /admin.
   */
  const refreshCars = async (user?: string) => {
    if (source() !== "fleet") {
      const who = user ? [user] : Object.keys(tokens()).map((k) => accountOf(k) ?? k);
      let next = cars();
      for (const u of who) {
        const list = await ownerFor(u).vehicles();
        next = [
          ...next.filter((c) => c.user.toLowerCase() !== u.toLowerCase() && !list.some((v) => v.vin === c.vin)),
          ...list.map((v) => ({ vin: v.vin, id: v.id, vehicleId: v.vehicleId, name: v.name, user: u })),
        ];
      }
      settings.set({ teslaCars: JSON.stringify(next) });
      hub.reset();
      return next;
    }
    const list = await fleet.vehicles();
    const had = new Map(cars().map((c) => [c.vin, c]));
    const next: LinkedCar[] = list.map((v) => ({
      vin: v.vin,
      id: v.id,
      // The owner streaming wants its own vehicle_id; Fleet's list has it too, kept for a switch back.
      vehicleId: v.vehicleId || had.get(v.vin)?.vehicleId || 0,
      name: v.name,
      user: had.get(v.vin)?.user ?? "",
    }));
    settings.set({ teslaCars: JSON.stringify(next) });
    hub.reset();
    return next;
  };

  // ---- for Tesla: the app's public key, on the domain registered with it ----
  app.get(PUBLIC_KEY_PATH, async (_request, reply) => reply.type("application/x-pem-file").header("Cache-Control", "public, max-age=3600").send(key.publicPem()));

  // ---- for the car page: whether this account has a car at all (the T badge), and its car's samples, as they come ----
  app.get("/api/car/info", async (request) => {
    const car = hub.carsFor(request.user!.name)[0];
    return car ? { linked: true, name: car.name } : { linked: false };
  });

  app.get("/api/car/stream", async (request, reply) => {
    const car = hub.carsFor(request.user!.name)[0];
    // No car for this user: 204, which also tells EventSource not to try again.
    if (!car) return reply.code(204).send();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    event("car", { name: car.name, source: source() });
    const off = hub.listen(car.vin, {
      sample: (s) => res.write(`data: ${JSON.stringify(s)}\n\n`),
      state: (state) => event("state", { state }),
    });
    // Every 5 s what the stream is and how old its last sample: the page sees a pipe gone dead (a comment it could not),
    // and samples the server has that never reached it (2026-10-09: 38 minutes "streaming" with none), and opens again.
    const beat = setInterval(() => event("beat", { state: hub.status()[car.vin]?.state ?? "stopped", sampleAgoMs: hub.sampleAgo(car.vin) }), 5_000);
    request.raw.on("close", () => { clearInterval(beat); off(); });
  });

  // ---- /admin ----
  const redirectOf = (request: FastifyRequest) => {
    const proto = String(request.headers["x-forwarded-proto"] ?? request.protocol).split(",")[0].trim();
    return `${proto}://${request.headers.host}${FLEET_CALLBACK}`;
  };
  const domainOf = (request: FastifyRequest) => String(request.headers.host ?? "").replace(/:\d+$/, "");
  const fail = (reply: FastifyReply, e: unknown) => {
    reply.request.log.warn({ err: (e as Error).message }, "tesla call failed");
    // Not 502: Cloudflare puts its own page in place of an origin's 502, and the reason never reaches /admin.
    return reply.code(422).send({ error: (e as Error).message });
  };

  // The links are each account's own: [me] and whether it is linked, for its buttons. A 사용자 sees their own cars and
  // line only, none of the Fleet app; a 관리자 sees every account's line (statusLines) and the Fleet app, not their buttons.
  app.get("/admin/car/state", { preHandler: selfGuard }, async (request) => {
    const me = access.accountFor(request, "");
    const mine = { me, linked: me ? ownerFor(me).linked : false };
    if (!access.isAdmin(request)) {
      const own = cars().filter((c) => me && c.user.toLowerCase() === me.toLowerCase());
      const streams = hub.status();
      return {
        ...mine,
        source: source(),
        fleet: null,
        cars: own,
        users: me ? [me] : [],
        streams: Object.fromEntries(own.map((c) => [c.vin, streams[c.vin]])),
        lines: me ? statusLines(me) : [],
      };
    }
    return { ...mine, ...adminState(request), lines: statusLines() };
  });
  const adminState = (request: FastifyRequest) => ({
    source: source(),
    fleet: {
      configured: fleet.configured,
      linked: fleet.linked,
      telemetryHost: settings.get("teslaTelemetryHost") ?? null,
      ca: telemetryCa(caFile) != null,
      redis: feed.listening,
      redisError: feed.lastError,
      redirect: redirectOf(request),
      publicKey: `https://${domainOf(request)}${PUBLIC_KEY_PATH}`,
      pairing: `https://tesla.com/_ak/${domainOf(request)}`,
    },
    cars: cars(),
    users: db.users().map((u) => u.name),
    streams: hub.status(),
  });
  /**
   * The account an owner call is for: the one logged in, 관리자 or 사용자 — a link is its account's own. A 사용자 cannot
   * link while the site takes the cars by Fleet (the one app login, the cars given out by a 관리자): their own login
   * would not be used.
   */
  const ownerTarget = (request: FastifyRequest, reply: FastifyReply, asked: unknown, what: string): string | null => {
    const named = access.accountFor(request, asked);
    if (named === null) { void reply.code(403).send({ error: OWN_ONLY }); return null; }
    if (!access.isAdmin(request) && source() !== "owner") { void reply.code(409).send({ error: "관리자가 Fleet Telemetry 방식으로 연결해 두었습니다 — 차는 관리자가 계정에 붙여 줍니다" }); return null; }
    const user = accountOf(named);
    if (!user) { void reply.code(400).send({ error: `${what} 계정을 고르세요` }); return null; }
    return user;
  };

  app.post<{ Body: { source?: string } }>("/admin/car/source", { preHandler: adminGuard }, async (request, reply) => {
    const next = request.body?.source;
    if (next !== "owner" && next !== "fleet") return reply.code(400).send({ error: "owner 또는 fleet" });
    settings.set({ teslaSource: next });
    hub.reset();
    return { source: next };
  });

  // The owner login, for the account named: its Tesla, its cars.
  app.post<{ Body: { user?: string } }>("/admin/car/owner/begin", { preHandler: selfGuard }, async (request, reply) => {
    const user = ownerTarget(request, reply, request.body?.user, "연결할");
    if (!user) return reply;
    return { url: ownerFor(user).begin() };
  });
  app.post<{ Body: { url?: string; user?: string } }>("/admin/car/owner/finish", { preHandler: selfGuard }, async (request, reply) => {
    const user = ownerTarget(request, reply, request.body?.user, "연결할");
    if (!user) return reply;
    try {
      await ownerFor(user).finish(String(request.body?.url ?? ""));
      if (source() !== "owner") settings.set({ teslaSource: "owner" });
      return { cars: await refreshCars(user) };
    } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { token?: string; user?: string } }>("/admin/car/owner/token", { preHandler: selfGuard }, async (request, reply) => {
    const user = ownerTarget(request, reply, request.body?.user, "연결할");
    if (!user) return reply;
    const token = String(request.body?.token ?? "").trim();
    if (!token) return reply.code(400).send({ error: "refresh token" });
    try {
      await ownerFor(user).useRefresh(token);
      if (source() !== "owner") settings.set({ teslaSource: "owner" });
      return { cars: await refreshCars(user) };
    } catch (e) { return fail(reply, e); }
  });

  app.post("/admin/car/fleet/begin", { preHandler: adminGuard }, async (request, reply) => {
    if (!fleet.configured) return reply.code(400).send({ error: "먼저 Fleet API Client ID와 Secret을 저장하세요" });
    return { url: fleet.begin(redirectOf(request)) };
  });
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(FLEET_CALLBACK, { preHandler: adminGuard }, async (request, reply) => {
    const q = request.query;
    const back = (params: Record<string, string>) => reply.redirect(`/admin?${new URLSearchParams({ car: "fleet", ...params })}#car`);
    if (q.error || !q.code || !q.state) return back({ error: q.error_description ?? q.error ?? "code 없음" });
    try {
      await fleet.finish(q.code, q.state, redirectOf(request));
      settings.set({ teslaSource: "fleet" });
      await refreshCars();
      return back({ ok: "1" });
    } catch (e) {
      return back({ error: (e as Error).message });
    }
  });
  app.post("/admin/car/fleet/register", { preHandler: adminGuard }, async (request, reply) => {
    try { return { registered: await fleet.register(domainOf(request)) }; } catch (e) { return fail(reply, e); }
  });
  app.post("/admin/car/fleet/configure", { preHandler: adminGuard }, async (_request, reply) => {
    const [host, port] = (settings.get("teslaTelemetryHost") ?? "").split(":");
    const ca = telemetryCa(caFile);
    if (!host) return reply.code(400).send({ error: "텔레메트리 서버 주소(host:port)를 먼저 저장하세요" });
    if (!ca) return reply.code(400).send({ error: `${caFile} 파일이 없습니다 (텔레메트리 서버 인증서의 체인)` });
    const vins = cars().map((c) => c.vin);
    if (!vins.length) return reply.code(400).send({ error: "연결된 차가 없습니다" });
    try { return { result: await fleet.configure(vins, host, Number(port || 443), ca) }; } catch (e) { return fail(reply, e); }
  });
  app.get("/admin/car/fleet/check", { preHandler: adminGuard }, async () => {
    const out: Record<string, unknown> = {};
    for (const c of cars()) out[c.vin] = await fleet.telemetryState(c.vin).catch((e: Error) => ({ error: e.message }));
    out.errors = await fleet.telemetryErrors().catch((e: Error) => ({ error: e.message }));
    return out;
  });

  // By the owner login, an account's own cars, 관리자 or not; by Fleet, the app's list, a 관리자's to fetch.
  app.post<{ Body: { user?: string } }>("/admin/car/refresh", { preHandler: selfGuard }, async (request, reply) => {
    if (!access.isAdmin(request) || source() === "owner") {
      const user = ownerTarget(request, reply, request.body?.user, "받을");
      if (!user) return reply;
      try {
        const me = user.toLowerCase();
        return { cars: (await refreshCars(user)).filter((c) => c.user.toLowerCase() === me) };
      } catch (e) { return fail(reply, e); }
    }
    try { return { cars: await refreshCars(accountOf(request.body?.user) ?? undefined) }; } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { vin?: string; user?: string } }>("/admin/car/user", { preHandler: adminGuard }, async (request, reply) => {
    const list = cars();
    const car = list.find((c) => c.vin === request.body?.vin);
    if (!car) return reply.code(404).send({ error: "그런 차 없음" });
    car.user = String(request.body?.user ?? "");
    settings.set({ teslaCars: JSON.stringify(list) });
    hub.reset();
    return { cars: list };
  });
  app.post<{ Body: { which?: string; user?: string } }>("/admin/car/unlink", { preHandler: selfGuard }, async (request, reply) => {
    if (request.body?.which === "fleet") {
      if (!access.isAdmin(request)) return reply.code(403).send({ error: "관리자만 할 수 있습니다" });
      fleet.unlink();
    } else {
      const named = access.accountFor(request, request.body?.user);
      if (named === null) return reply.code(403).send({ error: OWN_ONLY });
      const user = accountOf(named);
      if (!user) return reply.code(400).send({ error: "해제할 계정을 고르세요" });
      ownerFor(user).unlink();
      // Its cars go with it.
      settings.set({ teslaCars: JSON.stringify(cars().filter((c) => c.user.toLowerCase() !== user.toLowerCase())) });
    }
    hub.reset();
    return { ok: true };
  });

  /**
   * A line an account (or [only] that one's): whose car it is (only that account's car page gets its samples —
   * hub.carsFor), and what its stream is doing in words; an account not linked, or linked with no car yet, and a Fleet
   * car given to no one, too.
   */
  function statusLines(only?: string): string[] {
    const list = cars();
    const streams = hub.status();
    const lines: string[] = [];
    const accounts = db.users().map((u) => u.name).filter((n) => !only || n.toLowerCase() === only.toLowerCase());
    for (const name of accounts) {
      const theirs = list.filter((c) => c.user.toLowerCase() === name.toLowerCase());
      for (const c of theirs) {
        const s = streams[c.vin];
        lines.push(`${name} — ${c.name} …${c.vin.slice(-4)} · ${streamWord(s?.state ?? "stopped")}${s?.lastSampleAgoS != null ? ` · 마지막 ${s.lastSampleAgoS}초 전` : ""}${s?.lastError ? ` · ${s.lastError}` : ""}`);
      }
      if (!theirs.length) lines.push(source() === "owner" && ownerFor(name).linked ? `${name} — Tesla 연결됨 · 차 목록을 아직 안 받음 (그 계정에서 차량 목록 다시 받기)` : `${name} — 차 없음`);
    }
    if (!only) for (const c of list.filter((c) => !c.user)) lines.push(`(계정 없음) — ${c.name} …${c.vin.slice(-4)} · 아무도 안 받음`);
    return lines;
  }

  return {
    hub,
    /** /admin's 상태 row: how the cars are had, then a line an account (statusLines). */
    status(): string {
      return [source() === "fleet" ? "Fleet Telemetry" : "Owner 스트리밍", ...statusLines()].join("\n");
    },
    /** Forgets an account's link and cars: the account is gone (users.ts 삭제), and a new one of its name starts with none. */
    forget(name: string) {
      const key = name.toLowerCase();
      if (tokens()[key]) ownerFor(name).unlink();
      const list = cars();
      if (list.some((c) => c.user.toLowerCase() === key)) {
        // By the owner login the car was the account's Tesla's, and goes; by Fleet it stays, given to no one.
        settings.set({ teslaCars: JSON.stringify(source() === "fleet" ? list.map((c) => (c.user.toLowerCase() === key ? { ...c, user: "" } : c)) : list.filter((c) => c.user.toLowerCase() !== key)) });
        hub.reset();
      }
    },
  };
}

/** A stream's state in words, for /admin. */
export function streamWord(state: string): string {
  const words: Record<string, string> = {
    stopped: "대기 (그 계정의 차 화면이 열려 있을 때만 받습니다)",
    connecting: "연결 중",
    streaming: "받는 중",
    connected: "받는 중",
    waiting: "차 응답 기다리는 중 (잠들었거나 깨는 중)",
    error: "오류",
    reset: "다시 연결 중",
  };
  return words[state] ?? state;
}
