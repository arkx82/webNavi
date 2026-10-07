import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";
import type { Settings } from "./settings.js";

interface TokenAnswer {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  user?: { userId?: number | string; countryCode?: string };
  userId?: number | string;
  error?: string;
  error_description?: string;
}

/** How long a TIDAL call may take; one that never answers must not hold the player. */
const TIDAL_TIMEOUT_MS = 15_000;

/** One account's TIDAL login. */
interface TidalLink {
  refresh: string;
  userId: string;
  countryCode: string;
}
type Token = { token: string; expiresIn: number; userId: string; countryCode: string };

/**
 * TIDAL, each site account its own (linked on /admin for the account chosen): an account plays its own TIDAL's
 * lists, likes and streams, and one with none linked has no music button. The one login of before, the whole
 * site's, goes to the account the Tesla was linked to (june), else the first 관리자.
 */
export function registerMusic(
  app: FastifyInstance,
  settings: Settings,
  db: Db,
  adminOnly: (r: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
) {
  const keyOf = (name: string) => name.trim().toLowerCase();
  const links = (): Record<string, TidalLink> => {
    migrate();
    try { return JSON.parse(settings.get("tidalOwners") ?? "{}") as Record<string, TidalLink>; } catch { return {}; }
  };
  const linkOf = (user: string): TidalLink | undefined => links()[keyOf(user)];
  const setLink = (user: string, link: TidalLink | null) => {
    const all = links();
    if (link) all[keyOf(user)] = link; else delete all[keyOf(user)];
    settings.set({ tidalOwners: JSON.stringify(all) });
    cached.delete(keyOf(user));
  };
  const accountOf = (name: unknown): string | null => {
    const n = keyOf(String(name ?? ""));
    return n ? db.users().find((u) => u.name.toLowerCase() === n)?.name ?? null : null;
  };
  /** Tried until there is an account to give it to. */
  function migrate() {
    const refresh = settings.get("tidalRefresh");
    if (!refresh) return;
    let tesla: Record<string, string> = {};
    try { tesla = JSON.parse(settings.get("teslaOwners") ?? "{}") as Record<string, string>; } catch { /* none */ }
    const who = Object.keys(tesla).map(accountOf).find(Boolean) ?? db.users().find((u) => u.role === "admin")?.name;
    if (!who) return;
    let all: Record<string, TidalLink> = {};
    try { all = JSON.parse(settings.get("tidalOwners") ?? "{}") as Record<string, TidalLink>; } catch { /* none */ }
    all[keyOf(who)] ??= { refresh, userId: settings.get("tidalUserId") ?? "", countryCode: settings.get("tidalCountryCode") ?? "KR" };
    settings.set({ tidalOwners: JSON.stringify(all), tidalRefresh: "", tidalUserId: "", tidalCountryCode: "" });
    app.log.info(`TIDAL 연결을 ${who} 계정으로 옮김`);
  }
  migrate();

  /** Each account's access token while it lasts. */
  const cached = new Map<string, { token: string; until: number }>();
  /** One refresh at a time an account: two at once would each rotate the refresh token, and the later to finish keep a dead one. */
  const refreshing = new Map<string, Promise<Token>>();

  const getValidToken = async (user: string | undefined): Promise<Token> => {
    if (!user) throw new Error("login");
    const key = keyOf(user);
    const link = linkOf(user);
    if (!link?.refresh) throw new Error("TIDAL not connected");
    const had = cached.get(key);
    if (had && had.until > Date.now()) {
      return { token: had.token, expiresIn: Math.floor((had.until - Date.now()) / 1000), userId: link.userId, countryCode: link.countryCode };
    }
    let p = refreshing.get(key);
    if (!p) {
      p = refreshToken(user, link).finally(() => refreshing.delete(key));
      refreshing.set(key, p);
    }
    return p;
  };

  const refreshToken = async (user: string, link: TidalLink): Promise<Token> => {
    const clientId = settings.get("tidalClientId")!;
    const clientSecret = settings.get("tidalClientSecret");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: link.refresh,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      scope: "r_usr w_usr w_sub",
    });

    const resp = await fetch("https://auth.tidal.com/v1/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(TIDAL_TIMEOUT_MS),
    });

    const answer = (await resp.json().catch(() => ({}))) as TokenAnswer;
    if (!answer.access_token) {
      throw new Error(answer.error_description ?? answer.error ?? `refresh failed (${resp.status})`);
    }

    // Kept only while the account is still linked to the same login (not unlinked or linked anew meanwhile).
    if (answer.refresh_token && answer.refresh_token !== link.refresh && linkOf(user)?.refresh === link.refresh) {
      setLink(user, { ...link, refresh: answer.refresh_token });
    }

    const until = Date.now() + ((answer.expires_in ?? 3600) - 60) * 1000;
    if (linkOf(user)) cached.set(keyOf(user), { token: answer.access_token, until });

    return { token: answer.access_token, expiresIn: Math.floor((until - Date.now()) / 1000), userId: link.userId, countryCode: link.countryCode };
  };

  // ---- Device Code Flow (/admin) -------------------------------------------

  /** 1. Start Device Authorization Flow */
  app.post("/admin/music/tidal/device", { preHandler: adminOnly }, async (_req, reply) => {
    const clientId = settings.get("tidalClientId")!;
    const body = new URLSearchParams({
      client_id: clientId,
      scope: "r_usr w_usr w_sub",
    });

    const resp = await fetch("https://auth.tidal.com/v1/oauth2/device_authorization", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(TIDAL_TIMEOUT_MS),
    });

    const data = (await resp.json().catch(() => ({}))) as {
      deviceCode?: string;
      userCode?: string;
      verificationUri?: string;
      verificationUriComplete?: string;
      expiresIn?: number;
      interval?: number;
      error?: string;
      error_description?: string;
    };

    if (!resp.ok || !data.deviceCode) {
      return reply.code(resp.status).send({
        error: data.error_description ?? data.error ?? `Device authorization failed (${resp.status})`,
      });
    }

    return {
      deviceCode: data.deviceCode,
      userCode: data.userCode,
      verificationUri: data.verificationUri ?? "link.tidal.com",
      verificationUriComplete: data.verificationUriComplete ?? `link.tidal.com/${data.userCode}`,
      expiresIn: data.expiresIn ?? 300,
      interval: data.interval ?? 2,
    };
  });

  /** 2. Check Device Authorization Status (polling). A POST: it binds an account, which a link must not be able to do. */
  app.post<{ Body: { deviceCode?: string; user?: string } }>(
    "/admin/music/tidal/check",
    { preHandler: adminOnly },
    async (req, reply) => {
      const user = accountOf(req.body?.user);
      if (!user) return reply.code(400).send({ status: "error", error: "연결할 계정을 고르세요" });
      const deviceCode = typeof req.body?.deviceCode === "string" ? req.body.deviceCode : undefined;
      if (!deviceCode) return reply.code(400).send({ error: "deviceCode required" });

      const clientId = settings.get("tidalClientId")!;
      const clientSecret = settings.get("tidalClientSecret");

      const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        scope: "r_usr w_usr w_sub",
      });

      const resp = await fetch("https://auth.tidal.com/v1/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(TIDAL_TIMEOUT_MS),
      });

      const answer = (await resp.json().catch(() => ({}))) as TokenAnswer;

      if (!resp.ok) {
        if (answer.error === "authorization_pending" || answer.error === "slow_down") {
          return { status: "pending" };
        }
        return reply.code(resp.status).send({
          status: "error",
          error: answer.error_description ?? answer.error ?? "Authorization failed",
        });
      }

      if (!answer.refresh_token || !answer.access_token) {
        return reply.code(500).send({ status: "error", error: "No refresh token received" });
      }

      const userId = String(answer.user?.userId ?? answer.userId ?? "");
      const countryCode = answer.user?.countryCode ?? "KR";

      setLink(user, { refresh: answer.refresh_token, userId, countryCode });

      const until = Date.now() + ((answer.expires_in ?? 3600) - 60) * 1000;
      cached.set(keyOf(user), { token: answer.access_token, until });

      req.log.info({ user, userId, countryCode }, "TIDAL device account connected successfully");
      return { status: "ok" };
    },
  );

  /** Disconnect the account named. */
  app.post<{ Body: { user?: string } }>("/admin/music/tidal/disconnect", { preHandler: adminOnly }, async (req, reply) => {
    const user = accountOf(req.body?.user);
    if (!user) return reply.code(400).send({ error: "해제할 계정을 고르세요" });
    setLink(user, null);
    return { ok: true };
  });

  /** Each account and whether its TIDAL is linked, for /admin. */
  app.get("/admin/music/state", { preHandler: adminOnly }, async () => ({
    tidal: db.users().map((u) => ({ name: u.name, role: u.role, connected: !!linkOf(u.name)?.refresh })),
  }));

  // ---- Player & Music APIs (/api/music/tidal/*) ------------------------------

  /** Provide current access token and user info */
  app.get("/api/music/tidal/token", async (req, reply) => {
    try {
      const info = await getValidToken(req.user?.name);
      return info;
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  /** Track Audio Direct Stream URL */
  app.get<{ Params: { id: string }; Querystring: { quality?: string } }>(
    "/api/music/tidal/track/:id/stream",
    async (req, reply) => {
      const trackId = req.params.id;
      const quality = req.query.quality ?? "HIGH"; // HIGH = AAC 320k, LOW = AAC 96k, LOSSLESS = FLAC 44.1k/16bit

      let token: string;
      try {
        const info = await getValidToken(req.user?.name);
        token = info.token;
      } catch (e) {
        return reply.code(401).send({ error: (e as Error).message });
      }

      const streamEndpoint = `https://api.tidal.com/v1/tracks/${trackId}/playbackinfopostpaywall?playbackmode=STREAM&assetpresentation=FULL&audioquality=${encodeURIComponent(quality)}`;
      const resp = await fetch(streamEndpoint, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIDAL_TIMEOUT_MS),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        req.log.warn({ trackId, status: resp.status, errText }, "TIDAL stream fetch failed");
        return reply.code(resp.status).send({ error: `TIDAL stream error: ${resp.status}` });
      }

      const data = (await resp.json().catch(() => ({}))) as {
        manifestMimeType?: string;
        manifest?: string;
        audioQuality?: string;
      };

      if (!data.manifest) {
        return reply.code(502).send({ error: "No manifest in TIDAL response" });
      }

      try {
        const decoded = JSON.parse(Buffer.from(data.manifest, "base64").toString("utf8")) as {
          mimeType?: string;
          urls?: string[];
          codecs?: string;
        };
        const url = decoded.urls?.[0];
        if (!url) return reply.code(502).send({ error: "No audio URL in manifest" });

        return {
          url,
          mimeType: decoded.mimeType ?? "audio/mp4",
          codecs: decoded.codecs,
          audioQuality: data.audioQuality,
        };
      } catch (err) {
        return reply.code(502).send({ error: "Failed to decode TIDAL manifest" });
      }
    },
  );

  /** Direct audio redirect for HTML5 <audio> */
  app.get<{ Params: { id: string }; Querystring: { quality?: string } }>(
    "/api/music/tidal/track/:id/audio",
    async (req, reply) => {
      const trackId = req.params.id;
      const quality = req.query.quality ?? "HIGH";

      let token: string;
      try {
        const info = await getValidToken(req.user?.name);
        token = info.token;
      } catch (e) {
        return reply.code(401).send({ error: (e as Error).message });
      }

      const streamEndpoint = `https://api.tidal.com/v1/tracks/${trackId}/playbackinfopostpaywall?playbackmode=STREAM&assetpresentation=FULL&audioquality=${encodeURIComponent(quality)}`;
      const resp = await fetch(streamEndpoint, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIDAL_TIMEOUT_MS),
      });

      if (!resp.ok) {
        return reply.code(resp.status).send({ error: `TIDAL stream error: ${resp.status}` });
      }

      const data = (await resp.json().catch(() => ({}))) as { manifest?: string };
      if (!data.manifest) return reply.code(502).send({ error: "No manifest" });

      try {
        const decoded = JSON.parse(Buffer.from(data.manifest, "base64").toString("utf8")) as { urls?: string[] };
        const url = decoded.urls?.[0];
        if (!url) return reply.code(502).send({ error: "No stream url" });
        return reply.redirect(url, 302);
      } catch {
        return reply.code(502).send({ error: "Failed to parse manifest" });
      }
    },
  );

  /** Proxy for TIDAL v1 API (tracks, playlists, search, favorites) */
  app.get<{ Params: { "*": string } }>("/api/music/tidal/v1/*", async (req, reply) => {
    let token: string;
    let countryCode: string;
    try {
      const info = await getValidToken(req.user?.name);
      token = info.token;
      countryCode = info.countryCode || "KR";
    } catch (e) {
      return reply.code(401).send({ error: (e as Error).message });
    }

    const wildcard = req.params["*"];
    const url = new URL(`https://api.tidal.com/v1/${wildcard}`);
    url.searchParams.set("countryCode", countryCode);

    // Forward query params
    const query = req.query as Record<string, string>;
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }

    const upstream = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIDAL_TIMEOUT_MS),
    });

    reply.code(upstream.status);
    const contentType = upstream.headers.get("content-type");
    if (contentType) reply.header("Content-Type", contentType);

    return upstream.text();
  });

  // Liking: TIDAL's favorites take a form-encoded POST (trackIds), and a DELETE by track id. Only favorites/tracks.
  app.post<{ Params: { uid: string } }>("/api/music/tidal/v1/users/:uid/favorites/tracks", async (req, reply) => {
    let token: string, countryCode: string;
    try { const info = await getValidToken(req.user?.name); token = info.token; countryCode = info.countryCode || "KR"; } catch (e) { return reply.code(401).send({ error: (e as Error).message }); }
    const a = await fetch(`https://api.tidal.com/v1/users/${encodeURIComponent(req.params.uid)}/favorites/tracks?countryCode=${countryCode}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" }, body: String(req.body ?? ""), signal: AbortSignal.timeout(10_000),
    });
    reply.code(a.status);
    return a.text();
  });
  app.delete<{ Params: { uid: string; trackId: string } }>("/api/music/tidal/v1/users/:uid/favorites/tracks/:trackId", async (req, reply) => {
    let token: string;
    try { token = (await getValidToken(req.user?.name)).token; } catch (e) { return reply.code(401).send({ error: (e as Error).message }); }
    const a = await fetch(`https://api.tidal.com/v1/users/${encodeURIComponent(req.params.uid)}/favorites/tracks/${encodeURIComponent(req.params.trackId)}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    reply.code(a.status);
    return a.text();
  });

  // Events proxy fallback
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 1_000_000 },
    (_r, body, done) => done(null, body),
  );
  for (const [route, upstream] of [
    ["/api/music/tidal/events", "https://ec.tidal.com/api/event-batch"],
    ["/api/music/tidal/events/public", "https://ec.tidal.com/api/public/event-batch"],
  ]) {
    app.post(route, async (req, reply) => {
      const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
      if (req.headers.authorization) headers.Authorization = req.headers.authorization;
      try {
        const a = await fetch(upstream, {
          method: "POST",
          headers,
          body: String(req.body ?? ""),
          signal: AbortSignal.timeout(10_000),
        });
        reply.code(a.status).header("Content-Type", a.headers.get("content-type") ?? "text/xml");
        return a.text();
      } catch {
        return reply.code(502).send("");
      }
    });
  }

  /** Which services the account asking has linked, for the car page. */
  app.get("/api/music/state", async (req) => ({
    tidal: { configured: true, connected: !!(req.user && linkOf(req.user.name)?.refresh) },
  }));
}
