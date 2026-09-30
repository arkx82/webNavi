import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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

export function registerMusic(
  app: FastifyInstance,
  settings: Settings,
  adminOnly: (r: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
) {
  const cached = new Map<string, { token: string; until: number }>();

  const getValidToken = async (): Promise<{ token: string; expiresIn: number; userId: string; countryCode: string }> => {
    const refresh = settings.get("tidalRefresh");
    if (!refresh) throw new Error("TIDAL not connected");

    const had = cached.get("tidal");
    const userId = settings.get("tidalUserId") ?? "";
    const countryCode = settings.get("tidalCountryCode") ?? "KR";

    if (had && had.until > Date.now()) {
      return {
        token: had.token,
        expiresIn: Math.floor((had.until - Date.now()) / 1000),
        userId,
        countryCode,
      };
    }

    const clientId = settings.get("tidalClientId")!;
    const clientSecret = settings.get("tidalClientSecret");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      scope: "r_usr w_usr w_sub",
    });

    const resp = await fetch("https://auth.tidal.com/v1/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const answer = (await resp.json().catch(() => ({}))) as TokenAnswer;
    if (!answer.access_token) {
      throw new Error(answer.error_description ?? answer.error ?? `refresh failed (${resp.status})`);
    }

    if (answer.refresh_token && answer.refresh_token !== refresh) {
      settings.set({ tidalRefresh: answer.refresh_token });
    }

    const until = Date.now() + ((answer.expires_in ?? 3600) - 60) * 1000;
    cached.set("tidal", { token: answer.access_token, until });

    return {
      token: answer.access_token,
      expiresIn: Math.floor((until - Date.now()) / 1000),
      userId,
      countryCode,
    };
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

  /** 2. Check Device Authorization Status (polling) */
  app.get<{ Querystring: { deviceCode?: string } }>(
    "/admin/music/tidal/check",
    { preHandler: adminOnly },
    async (req, reply) => {
      const deviceCode = req.query.deviceCode;
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
      });

      const answer = (await resp.json().catch(() => ({}))) as TokenAnswer;

      if (!resp.ok) {
        if (answer.error === "authorization_pending") {
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

      settings.set({
        tidalRefresh: answer.refresh_token,
        tidalUserId: userId,
        tidalCountryCode: countryCode,
      });

      const until = Date.now() + ((answer.expires_in ?? 3600) - 60) * 1000;
      cached.set("tidal", { token: answer.access_token, until });

      req.log.info({ userId, countryCode }, "TIDAL device account connected successfully");
      return { status: "ok" };
    },
  );

  /** Disconnect account */
  app.post("/admin/music/tidal/disconnect", { preHandler: adminOnly }, async () => {
    settings.set({ tidalRefresh: "", tidalUserId: "", tidalCountryCode: "" });
    cached.delete("tidal");
    return { ok: true };
  });

  // ---- Player & Music APIs (/api/music/tidal/*) ------------------------------

  /** Provide current access token and user info */
  app.get("/api/music/tidal/token", async (_req, reply) => {
    try {
      const info = await getValidToken();
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
        const info = await getValidToken();
        token = info.token;
      } catch (e) {
        return reply.code(401).send({ error: (e as Error).message });
      }

      const streamEndpoint = `https://api.tidal.com/v1/tracks/${trackId}/playbackinfopostpaywall?playbackmode=STREAM&assetpresentation=FULL&audioquality=${encodeURIComponent(quality)}`;
      const resp = await fetch(streamEndpoint, {
        headers: { Authorization: `Bearer ${token}` },
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
        const info = await getValidToken();
        token = info.token;
      } catch (e) {
        return reply.code(401).send({ error: (e as Error).message });
      }

      const streamEndpoint = `https://api.tidal.com/v1/tracks/${trackId}/playbackinfopostpaywall?playbackmode=STREAM&assetpresentation=FULL&audioquality=${encodeURIComponent(quality)}`;
      const resp = await fetch(streamEndpoint, {
        headers: { Authorization: `Bearer ${token}` },
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
      const info = await getValidToken();
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
    });

    reply.code(upstream.status);
    const contentType = upstream.headers.get("content-type");
    if (contentType) reply.header("Content-Type", contentType);

    return upstream.text();
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

  /** Which services are connected, for the car page and the admin. */
  app.get("/api/music/state", async () => ({
    tidal: { configured: true, connected: !!settings.get("tidalRefresh") },
  }));
}
