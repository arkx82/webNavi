import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Settings } from "./settings.js";

/**
 * The owner's streaming accounts, connected once from /admin and used by
 * the car page after. The page never sees a client secret or a refresh
 * token: it asks this server for a short-lived access token when the
 * player SDK wants one, and the server refreshes it here.
 *
 * Both speak OAuth 2 authorization-code, with a difference in how the app
 * proves itself: Spotify as a confidential client (Client ID + Secret),
 * TIDAL with PKCE — a one-time verifier made here and its hash sent with
 * the login — and no secret at all for a user's login (TIDAL's SDK docs:
 * the secret is only for app-only client credentials). A TIDAL secret, if
 * typed, is still sent to the token endpoint, as the SDK does.
 */
interface Service {
  name: "spotify" | "tidal";
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  idField: "spotifyClientId" | "tidalClientId";
  secretField: "spotifyClientSecret" | "tidalClientSecret";
  refreshField: "spotifyRefresh" | "tidalRefresh";
  /** Extra query on the authorize step. */
  extra?: Record<string, string>;
  /** Proof by PKCE; the secret is then optional. */
  pkce?: boolean;
}

const SERVICES: Service[] = [
  {
    name: "spotify",
    authorizeUrl: "https://accounts.spotify.com/authorize",
    tokenUrl: "https://accounts.spotify.com/api/token",
    scope: [
      "streaming", "user-read-email", "user-read-private",
      "user-read-playback-state", "user-modify-playback-state",
      "playlist-read-private", "playlist-read-collaborative", "user-library-read",
    ].join(" "),
    idField: "spotifyClientId", secretField: "spotifyClientSecret", refreshField: "spotifyRefresh",
    extra: { show_dialog: "true" },
  },
  {
    name: "tidal",
    authorizeUrl: "https://login.tidal.com/authorize",
    tokenUrl: "https://auth.tidal.com/v1/oauth2/token",
    scope: "user.read collection.read playlists.read playback",
    idField: "tidalClientId", secretField: "tidalClientSecret", refreshField: "tidalRefresh",
    pkce: true,
  },
];

interface TokenAnswer {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

export function registerMusic(app: FastifyInstance, settings: Settings, adminOnly: (r: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  const cached = new Map<string, { token: string; until: number }>();
  /** PKCE verifiers by login, kept here (never in the URL) until the callback or ten minutes. */
  const verifiers = new Map<string, { verifier: string; at: number }>();
  const ready = (s: Service) => !!settings.get(s.idField) && (s.pkce || !!settings.get(s.secretField));

  const origin = (request: FastifyRequest) => {
    const proto = (request.headers["x-forwarded-proto"] as string | undefined) ?? request.protocol;
    const host = (request.headers["x-forwarded-host"] as string | undefined) ?? request.headers.host;
    return `${proto}://${host}`;
  };
  const redirectFor = (request: FastifyRequest, s: Service) => `${origin(request)}/api/music/${s.name}/callback`;

  for (const s of SERVICES) {
    // From /admin (under its path, so its cookie comes along): off to the
    // service's consent page. The state is signed so the callback, which
    // has no cookie, knows it began here.
    app.get(`/admin/music/${s.name}/login`, { preHandler: adminOnly }, async (request, reply) => {
      const id = settings.get(s.idField);
      if (!id || !ready(s)) return reply.code(400).send({ error: s.pkce ? `${s.name} client id first` : `${s.name} client id/secret first` });
      const stamp = String(Date.now());
      const url = new URL(s.authorizeUrl);
      url.searchParams.set("client_id", id);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", redirectFor(request, s));
      url.searchParams.set("scope", s.scope);
      url.searchParams.set("state", `${stamp}~${settings.sign(`${s.name}:${stamp}`)}`);
      for (const [k, v] of Object.entries(s.extra ?? {})) url.searchParams.set(k, v);
      if (s.pkce) {
        const verifier = randomBytes(48).toString("base64url");
        for (const [k, v] of verifiers) if (Date.now() - v.at > 600_000) verifiers.delete(k);
        verifiers.set(`${s.name}:${stamp}`, { verifier, at: Date.now() });
        url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
        url.searchParams.set("code_challenge_method", "S256");
      }
      return reply.redirect(url.toString());
    });

    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(`/api/music/${s.name}/callback`, async (request, reply) => {
      const { code, state, error } = request.query;
      const [stamp, sig] = (state ?? "").split("~");
      if (!stamp || !sig || !settings.verify(`${s.name}:${stamp}`, sig) || Date.now() - Number(stamp) > 600_000) {
        return reply.code(400).send({ error: "state" });
      }
      if (error || !code) return reply.redirect(`/admin?music=${s.name}&error=${encodeURIComponent(error ?? "no code")}`);
      const form: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: redirectFor(request, s) };
      if (s.pkce) {
        const kept = verifiers.get(`${s.name}:${stamp}`);
        verifiers.delete(`${s.name}:${stamp}`);
        if (!kept) return reply.redirect(`/admin?music=${s.name}&error=${encodeURIComponent("login expired — start again")}`);
        form.code_verifier = kept.verifier;
      }
      const answer = await exchange(s, settings, form);
      if (!answer.refresh_token) return reply.redirect(`/admin?music=${s.name}&error=${encodeURIComponent(answer.error_description ?? answer.error ?? "no refresh token")}`);
      settings.set({ [s.refreshField]: answer.refresh_token });
      cached.set(s.name, { token: answer.access_token, until: Date.now() + (answer.expires_in - 60) * 1000 });
      request.log.info({ service: s.name }, "music account connected");
      return reply.redirect(`/admin?music=${s.name}&ok=1`);
    });

    // For the car page: a live access token, refreshed here when stale.
    app.get(`/api/music/${s.name}/token`, async (request, reply) => {
      const refresh = settings.get(s.refreshField);
      if (!refresh) return reply.code(404).send({ error: `${s.name} not connected` });
      const had = cached.get(s.name);
      // TIDAL's SDK wants the client id in the browser too; it is public.
      const clientId = s.name === "tidal" ? settings.get(s.idField) : undefined;
      if (had && had.until > Date.now()) return { token: had.token, expiresIn: Math.floor((had.until - Date.now()) / 1000), clientId };
      const answer = await exchange(s, settings, { grant_type: "refresh_token", refresh_token: refresh });
      if (!answer.access_token) {
        request.log.warn({ service: s.name, error: answer.error }, "token refresh failed");
        return reply.code(502).send({ error: answer.error_description ?? answer.error ?? "refresh failed" });
      }
      // Tidal rotates refresh tokens; Spotify keeps the same one unless it says otherwise.
      if (answer.refresh_token && answer.refresh_token !== refresh) settings.set({ [s.refreshField]: answer.refresh_token });
      cached.set(s.name, { token: answer.access_token, until: Date.now() + (answer.expires_in - 60) * 1000 });
      return { token: answer.access_token, expiresIn: answer.expires_in - 60, clientId };
    });

    app.post(`/admin/music/${s.name}/disconnect`, { preHandler: adminOnly }, async () => {
      settings.set({ [s.refreshField]: "" });
      cached.delete(s.name);
      return { ok: true };
    });
  }

  /** Which services are connected, for the car page and the admin. */
  app.get("/api/music/state", async () => Object.fromEntries(
    SERVICES.map((s) => [s.name, { configured: ready(s), connected: !!settings.get(s.refreshField), needsSecret: !s.pkce }]),
  ));
}

async function exchange(s: Service, settings: Settings, form: Record<string, string>): Promise<TokenAnswer> {
  const id = settings.get(s.idField)!;
  const secret = settings.get(s.secretField);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  // A confidential client says who it is in the header; a PKCE one by its client_id alone (with the secret if one was typed).
  if (!s.pkce) headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  const body = new URLSearchParams({ ...form, client_id: id, ...(s.pkce && secret ? { client_secret: secret } : {}) });
  const answer = await fetch(s.tokenUrl, { method: "POST", headers, body: body.toString() });
  return (await answer.json().catch(() => ({ error: `${answer.status}` }))) as TokenAnswer;
}
