import { createHash, randomBytes } from "node:crypto";
import { connect as http2 } from "node:http2";
import type { Settings } from "../settings.js";
import { MPH_MPS, MILE_M, OdoResolution, gearOf, type CarSample } from "./sample.js";

/**
 * The car through Tesla's owner API and its streaming, the way TeslaMate
 * reads it: the owner's own login (no developer app, no key in the car,
 * nothing the car has to reach on this host), a sample about every half
 * second while it drives — speed, odometer, and where the car thinks it
 * is. Not an API Tesla documents; Fleet Telemetry (fleet.ts) is the one it
 * does, and the page takes either the same.
 */
export const OWNER_AUTH = "https://auth.tesla.com/oauth2/v3";
export const OWNER_API = "https://owner-api.teslamotors.com";
export const OWNER_STREAM = "wss://streaming.vn.teslamotors.com/streaming/";
const CLIENT_ID = "ownerapi";
/**
 * Where Tesla's login ends, its address carrying the code: the Tesla app's own scheme, the only one Tesla takes for
 * this client since April 2026 (…/void/callback was retired). No browser opens it, so the address is copied from
 * where the browser says it could not (DevTools' console) and pasted on /admin.
 */
export const OWNER_REDIRECT = "tesla://auth/callback";
const SCOPE = "openid email offline_access";
/** The columns TeslaMate asks for, in its order: the stream answers each frame as "time," and these. */
export const COLUMNS = ["speed", "odometer", "soc", "elevation", "est_heading", "est_lat", "est_lng", "power", "shift_state", "range", "est_range", "heading"] as const;
const TIMEOUT_MS = 15_000;

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface OwnerVehicle {
  /** The owner API's id (for its REST calls), the streaming's vehicle_id, the VIN. */
  id: string;
  vehicleId: number;
  vin: string;
  name: string;
  state: string;
}

export class OwnerAuth {
  private access: { token: string; until: number } | null = null;
  private refreshing: Promise<string> | null = null;
  /** Logins begun on /admin and not yet finished, by state: the PKCE verifier each needs. */
  private pending = new Map<string, { verifier: string; at: number }>();

  constructor(private settings: Settings, private post: typeof postH2 = postH2) {}

  get linked(): boolean {
    return !!this.settings.get("teslaRefresh");
  }

  /** A fresh access token: the kept one while it lasts, else one refresh at a time (the refresh token is single use). */
  async token(): Promise<string> {
    if (this.access && this.access.until > Date.now()) return this.access.token;
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** The streaming said the token is no good: the next call refreshes. */
  forget() {
    this.access = null;
  }

  private async refresh(): Promise<string> {
    const refresh = this.settings.get("teslaRefresh");
    if (!refresh) throw new Error("Tesla 계정이 연결되지 않음");
    return this.exchange({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refresh, scope: SCOPE });
  }

  /**
   * The token call, over HTTP/2 and TLS 1.3. Since June 2026 auth.tesla.com answers a request over HTTP/1.1 (what
   * fetch speaks) with a token for the Fleet API only, which the owner API refuses with 403 "forbidden, see
   * fleet-api"; asked over HTTP/2 it gives one the owner API takes (TeslaMate #5384, its fix in lib/teslamate/http.ex).
   */
  private async exchange(body: Record<string, string>): Promise<string> {
    const { status, text } = await this.post(`${OWNER_AUTH}/token`, new URLSearchParams(body).toString(), "application/x-www-form-urlencoded");
    let answer: TokenAnswer = {};
    try { answer = JSON.parse(text) as TokenAnswer; } catch { /* an HTML error page: the status says it */ }
    if (status !== 200 || !answer.access_token) throw new Error(answer.error_description ?? answer.error ?? `Tesla 로그인 ${status}`);
    // A new refresh token each time (the old one is spent): kept before anything else can fail.
    if (answer.refresh_token) this.settings.set({ teslaRefresh: answer.refresh_token });
    this.access = { token: answer.access_token, until: Date.now() + ((answer.expires_in ?? 28_800) - 300) * 1000 };
    return answer.access_token;
  }

  /** A refresh token pasted on /admin (from a token app): tried at once, kept only if it works. */
  async useRefresh(refresh: string) {
    const had = this.settings.get("teslaRefresh");
    this.settings.set({ teslaRefresh: refresh });
    this.access = null;
    try {
      await this.token();
    } catch (e) {
      this.settings.set({ teslaRefresh: had ?? "" });
      throw e;
    }
  }

  /** The address of Tesla's own login, for the owner to open; its end page's address comes back to [finish]. */
  begin(): string {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.at > 15 * 60_000) this.pending.delete(k);
    const verifier = randomBytes(64).toString("base64url");
    const state = randomBytes(16).toString("base64url");
    this.pending.set(state, { verifier, at: now });
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      redirect_uri: OWNER_REDIRECT,
      response_type: "code",
      scope: SCOPE,
      state,
    });
    return `${OWNER_AUTH}/authorize?${q}`;
  }

  /**
   * The address the login ended on ("tesla://auth/callback?code=…&state=…"), pasted back — alone, or inside the
   * console's "Failed to launch '…'" line: its code for tokens.
   */
  async finish(pasted: string) {
    const found = pasted.match(/tesla:\/\/auth\/callback\?[^\s'"]+/)?.[0] ?? pasted.trim();
    let url: URL;
    try { url = new URL(found); } catch { throw new Error("tesla://auth/callback?code=… 주소를 붙여 넣으세요"); }
    const code = url.searchParams.get("code"), state = url.searchParams.get("state") ?? "";
    const begun = this.pending.get(state);
    if (!code) throw new Error("주소에 code가 없습니다");
    if (!begun) throw new Error("이 로그인은 만료됐습니다 — Tesla 로그인을 다시 누르세요");
    this.pending.delete(state);
    await this.exchange({ grant_type: "authorization_code", client_id: CLIENT_ID, code, code_verifier: begun.verifier, redirect_uri: OWNER_REDIRECT });
  }

  unlink() {
    this.settings.set({ teslaRefresh: "" });
    this.access = null;
  }

  async vehicles(): Promise<OwnerVehicle[]> {
    // The account's products (cars, and Powerwalls without a VIN): /api/1/vehicles is Fleet API only now (412).
    const resp = await fetch(`${OWNER_API}/api/1/products`, {
      headers: { Authorization: `Bearer ${await this.token()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (resp.status === 403) throw new Error("Tesla가 이 계정의 Owner API를 막았습니다 (403) — Fleet Telemetry로 연결하세요");
    if (!resp.ok) throw new Error(`차량 목록 ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const body = (await resp.json()) as { response?: { id_s?: string; id?: number; vehicle_id?: number; vin?: string; display_name?: string; state?: string }[] };
    return (body.response ?? [])
      .filter((v) => v.vin && v.vehicle_id != null)
      .map((v) => ({ id: v.id_s ?? String(v.id), vehicleId: v.vehicle_id!, vin: v.vin!, name: v.display_name || `Tesla …${v.vin!.slice(-4)}`, state: v.state ?? "" }));
  }
}

/** A POST over HTTP/2 (TLS 1.3 only), the answer whole: what fetch cannot be made to do. */
export function postH2(url: string, body: string, type: string): Promise<{ status: number; text: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const session = http2(u.origin, { minVersion: "TLSv1.3" });
    const done = (e?: Error) => { clearTimeout(timer); session.close(); if (e) reject(e); };
    const timer = setTimeout(() => { session.destroy(); reject(new Error("Tesla 로그인 시간 초과")); }, TIMEOUT_MS);
    session.on("error", done);
    const req = session.request({ ":method": "POST", ":path": u.pathname + u.search, "content-type": type, accept: "application/json", "content-length": Buffer.byteLength(body) });
    let status = 0;
    const chunks: Buffer[] = [];
    req.on("response", (h) => { status = Number(h[":status"]); });
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => { done(); resolve({ status, text: Buffer.concat(chunks).toString("utf8") }); });
    req.on("error", done);
    req.end(body);
  });
}

/** One "time,speed,odometer,…" frame, in COLUMNS' order, as a sample; [odo] reads the odometer's fineness as it goes. */
export function parseFrame(value: string, odo = new OdoResolution()): CarSample | null {
  const cells = value.split(",");
  const t = Number(cells[0]);
  if (!Number.isFinite(t) || t <= 0) return null;
  const cell = (name: (typeof COLUMNS)[number]) => cells[COLUMNS.indexOf(name) + 1] ?? "";
  const num = (name: (typeof COLUMNS)[number]) => { const c = cell(name); if (c === "") return null; const n = Number(c); return Number.isFinite(n) ? n : null; };
  const gear = gearOf(cell("shift_state"));
  const mph = num("speed");
  const miles = num("odometer");
  const lat = num("est_lat"), lon = num("est_lng");
  return {
    t,
    // Empty in P (and as it wakes): standing.
    speedMps: mph == null ? (gear == null || gear === "P" ? null : 0) : mph * MPH_MPS,
    odoM: miles == null ? null : miles * MILE_M,
    odoResM: miles == null ? odo.metres() : odo.feed(cell("odometer")),
    est: lat != null && lon != null && (lat !== 0 || lon !== 0) ? { lon, lat, heading: num("est_heading") } : null,
    gear,
  };
}

export type StreamState = "connecting" | "streaming" | "waiting" | "stopped" | "error";

/**
 * The streaming for one car, kept open while someone is listening: the
 * subscription sent on connect, re-sent when the car drops off it (as it
 * does on waking and between drives), and the whole socket opened again
 * when it goes quiet or closes — sooner while the car was last seen in
 * gear, as TeslaMate does.
 */
export class OwnerStream {
  private ws: WebSocket | null = null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private quiet: NodeJS.Timeout | null = null;
  private attempts = 0;
  private disconnects = 0;
  private lastShift: string | null = null;
  private odo = new OdoResolution();
  state: StreamState = "stopped";
  lastError: string | null = null;
  lastSampleAt = 0;

  constructor(
    private vehicleId: number,
    private auth: Pick<OwnerAuth, "token" | "forget">,
    private onSample: (s: CarSample) => void,
    private onState: (state: StreamState) => void = () => {},
    private log: (m: string) => void = () => {},
    private url = OWNER_STREAM,
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    this.clear();
    try { this.ws?.close(); } catch { /* closing a socket still opening throws in some runtimes */ }
    this.ws = null;
    this.set("stopped");
  }

  private set(state: StreamState) {
    if (state === this.state) return;
    this.state = state;
    this.onState(state);
  }

  private clear() {
    if (this.timer) clearTimeout(this.timer);
    if (this.quiet) clearTimeout(this.quiet);
    this.timer = this.quiet = null;
  }

  /** Nothing heard for half a minute: the socket is let go and opened again. */
  private armQuiet() {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => { this.log("streaming: quiet, reconnecting"); this.ws?.close(); }, 30_000);
  }

  private connect() {
    if (!this.running) return;
    this.set("connecting");
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.addEventListener("open", () => void this.subscribe());
    ws.addEventListener("message", (e) => this.message(e.data));
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clear();
      if (!this.running) return;
      // 1, 2, 4 … 30 s: a car parked does not need asking every second.
      const ms = Math.min(30_000, 1000 * 2 ** Math.min(5, this.attempts++));
      this.set("waiting");
      this.timer = setTimeout(() => this.connect(), ms);
    });
    ws.addEventListener("error", () => { this.lastError = "streaming socket error"; });
  }

  private async subscribe() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    let token: string;
    try {
      token = await this.auth.token();
    } catch (e) {
      this.lastError = (e as Error).message;
      this.set("error");
      ws.close();
      return;
    }
    ws.send(JSON.stringify({ msg_type: "data:subscribe_oauth", token, value: COLUMNS.join(","), tag: String(this.vehicleId) }));
    this.armQuiet();
  }

  private message(data: unknown) {
    const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : String(data);
    let msg: { msg_type?: string; tag?: string; value?: string; error_type?: string };
    try { msg = JSON.parse(text); } catch { return; }
    this.armQuiet();
    if (msg.msg_type === "data:update" && msg.tag === String(this.vehicleId) && typeof msg.value === "string") {
      const s = parseFrame(msg.value, this.odo);
      if (!s) return;
      this.attempts = 0;
      this.disconnects = 0;
      this.lastShift = s.gear ?? null;
      this.lastSampleAt = Date.now();
      this.lastError = null;
      this.set("streaming");
      this.onSample(s);
      return;
    }
    if (msg.msg_type !== "data:error") return;
    if (msg.error_type === "vehicle_disconnected") {
      // The car fell off the subscription (asleep, waking, a drive's start): asked again, quickly while it was in gear.
      const d = this.disconnects++;
      const ms = this.lastShift && "PDNR".includes(this.lastShift) ? Math.min(8_000, 1000 * 1.3 ** d) : Math.min(30_000, 15_000 + 1000 * d);
      this.set("waiting");
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.subscribe(), ms);
      return;
    }
    this.lastError = `${msg.error_type}: ${msg.value ?? ""}`.slice(0, 200);
    if (msg.error_type === "client_error" && /validate token/i.test(msg.value ?? "")) {
      this.auth.forget();
      this.ws?.close();
    } else if (msg.error_type === "client_error") {
      this.ws?.close();
    }
    this.log(`streaming: ${this.lastError}`);
  }
}
