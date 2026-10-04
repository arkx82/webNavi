import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Where Tesla's Fleet login comes back to: the path registered with the app on developer.tesla.com. */
export const FLEET_CALLBACK = "/admin/car/tesla/callback";
export const PUBLIC_KEY_PATH = "/.well-known/appspecific/com.tesla.3p.public-key.pem";

export function registerCar(app: FastifyInstance, settings: Settings, db: Db, adminGuard: Guard, configDir: string, workDir: string) {
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
    // A comment every 15 s: the tunnel and the browser keep a quiet stream open.
    const beat = setInterval(() => res.write(": \n\n"), 15_000);
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

  app.get("/admin/car/state", { preHandler: adminGuard }, async (request) => ({
    source: source(),
    owner: { linked: Object.keys(tokens()).length > 0 },
    owners: db.users().map((u) => ({ name: u.name, role: u.role, linked: ownerFor(u.name).linked })),
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
  }));

  app.post<{ Body: { source?: string } }>("/admin/car/source", { preHandler: adminGuard }, async (request, reply) => {
    const next = request.body?.source;
    if (next !== "owner" && next !== "fleet") return reply.code(400).send({ error: "owner 또는 fleet" });
    settings.set({ teslaSource: next });
    hub.reset();
    return { source: next };
  });

  // The owner login, for the account named: its Tesla, its cars.
  app.post<{ Body: { user?: string } }>("/admin/car/owner/begin", { preHandler: adminGuard }, async (request, reply) => {
    const user = accountOf(request.body?.user);
    if (!user) return reply.code(400).send({ error: "연결할 계정을 고르세요" });
    return { url: ownerFor(user).begin() };
  });
  app.post<{ Body: { url?: string; user?: string } }>("/admin/car/owner/finish", { preHandler: adminGuard }, async (request, reply) => {
    const user = accountOf(request.body?.user);
    if (!user) return reply.code(400).send({ error: "연결할 계정을 고르세요" });
    try {
      await ownerFor(user).finish(String(request.body?.url ?? ""));
      if (source() !== "owner") settings.set({ teslaSource: "owner" });
      return { cars: await refreshCars(user) };
    } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { token?: string; user?: string } }>("/admin/car/owner/token", { preHandler: adminGuard }, async (request, reply) => {
    const user = accountOf(request.body?.user);
    if (!user) return reply.code(400).send({ error: "연결할 계정을 고르세요" });
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
    if (!ca) return reply.code(400).send({ error: `${caFile} 이 없습니다 (텔레메트리 서버 인증서의 체인)` });
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

  app.post<{ Body: { user?: string } }>("/admin/car/refresh", { preHandler: adminGuard }, async (request, reply) => {
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
  app.post<{ Body: { which?: string; user?: string } }>("/admin/car/unlink", { preHandler: adminGuard }, async (request, reply) => {
    if (request.body?.which === "fleet") fleet.unlink();
    else {
      const user = accountOf(request.body?.user);
      if (!user) return reply.code(400).send({ error: "해제할 계정을 고르세요" });
      ownerFor(user).unlink();
      // Its cars go with it.
      settings.set({ teslaCars: JSON.stringify(cars().filter((c) => c.user.toLowerCase() !== user.toLowerCase())) });
    }
    hub.reset();
    return { ok: true };
  });

  return {
    hub,
    /** A word for /admin's 상태 table. */
    status(): string {
      const list = cars();
      if (!list.length) return Object.keys(tokens()).length || fleet.linked ? "연결됨 · 차 없음" : "연결 안 됨";
      const streams = hub.status();
      return `${source() === "fleet" ? "Fleet Telemetry" : "Owner 스트리밍"} · ` + list.map((c) => {
        const s = streams[c.vin];
        return `${c.name}(${c.user || "계정 없음"}): ${s.state}${s.lastSampleAgoS != null ? ` (${s.lastSampleAgoS}초 전)` : ""}${s.lastError ? ` · ${s.lastError}` : ""}`;
      }).join(", ");
    },
  };
}
