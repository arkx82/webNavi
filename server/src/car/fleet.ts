import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Settings } from "../settings.js";
import { RedisSubscriber } from "./redis.js";
import { MILE_M, MPH_MPS, OdoResolution, type CarSample } from "./sample.js";
import { signForFleet, type FleetKey } from "./schnorr.js";
import type { CarSource } from "./hub.js";

/**
 * Tesla's documented way: Fleet API for the login and the car's list,
 * Fleet Telemetry for the samples. The car streams to our own
 * fleet-telemetry server (docker-compose's "fleet" profile, reached on a
 * port of its own since the car's mTLS must end there and not at
 * Cloudflare), which publishes each record to Redis; we listen there.
 *
 * Korea is in the North America / Asia-Pacific region.
 */
export const FLEET_API = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const FLEET_AUTH = "https://auth.tesla.com/oauth2/v3";
const FLEET_TOKEN = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
const SCOPE = "openid offline_access vehicle_device_data vehicle_location";
/** The redis dispatcher's channels: "<namespace>_<record type>_{<VIN>}". */
export const NAMESPACE = "tesla_telemetry";
const TIMEOUT_MS = 15_000;
/**
 * What the car is asked to send, and how often at most: only on a change,
 * so standing costs nothing. Speed and odometer each second while moving
 * (about 7,200 signals an hour, of the 1.5 million a month the $10 credit
 * covers), the car's own place every five for the record.
 */
export const TELEMETRY_FIELDS = {
  VehicleSpeed: { interval_seconds: 1 },
  Odometer: { interval_seconds: 1 },
  Gear: { interval_seconds: 1 },
  Location: { interval_seconds: 5 },
  GpsHeading: { interval_seconds: 5 },
};

interface TokenAnswer { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }

export interface FleetVehicle { id: string; vehicleId: number; vin: string; name: string; state: string }

export class FleetApi {
  private access: { token: string; until: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private partner: { token: string; until: number } | null = null;
  private states = new Map<string, number>();

  constructor(private settings: Settings, private key: FleetKey) {}

  get configured(): boolean {
    return !!(this.settings.get("teslaClientId") && this.settings.get("teslaClientSecret"));
  }

  get linked(): boolean {
    return !!this.settings.get("teslaFleetRefresh");
  }

  /** Tesla's login for the owner, coming back to [redirect] with a code. */
  begin(redirect: string): string {
    const now = Date.now();
    for (const [k, at] of this.states) if (now - at > 15 * 60_000) this.states.delete(k);
    const state = randomBytes(16).toString("base64url");
    this.states.set(state, now);
    const q = new URLSearchParams({ response_type: "code", client_id: this.settings.get("teslaClientId") ?? "", redirect_uri: redirect, scope: SCOPE, state, prompt_missing_scopes: "true" });
    return `${FLEET_AUTH}/authorize?${q}`;
  }

  async finish(code: string, state: string, redirect: string) {
    if (!this.states.delete(state)) throw new Error("이 로그인은 만료됐습니다 — 다시 연결하세요");
    await this.exchange({
      grant_type: "authorization_code",
      client_id: this.settings.get("teslaClientId") ?? "",
      client_secret: this.settings.get("teslaClientSecret") ?? "",
      code,
      audience: FLEET_API,
      redirect_uri: redirect,
    });
  }

  unlink() {
    this.settings.set({ teslaFleetRefresh: "" });
    this.access = null;
  }

  async token(): Promise<string> {
    if (this.access && this.access.until > Date.now()) return this.access.token;
    this.refreshing ??= (async () => {
      const refresh = this.settings.get("teslaFleetRefresh");
      if (!refresh) throw new Error("Fleet API 계정이 연결되지 않음");
      return this.exchange({ grant_type: "refresh_token", client_id: this.settings.get("teslaClientId") ?? "", refresh_token: refresh });
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async exchange(form: Record<string, string>): Promise<string> {
    const answer = await tokenCall(form);
    // Single use: the new one kept before anything else can fail.
    if (answer.refresh_token) this.settings.set({ teslaFleetRefresh: answer.refresh_token });
    this.access = { token: answer.access_token!, until: Date.now() + ((answer.expires_in ?? 28_800) - 300) * 1000 };
    return answer.access_token!;
  }

  /** The app's own token, for registering it and reading its telemetry errors. */
  private async partnerToken(): Promise<string> {
    if (this.partner && this.partner.until > Date.now()) return this.partner.token;
    const answer = await tokenCall({
      grant_type: "client_credentials",
      client_id: this.settings.get("teslaClientId") ?? "",
      client_secret: this.settings.get("teslaClientSecret") ?? "",
      scope: SCOPE.replace("offline_access ", ""),
      audience: FLEET_API,
    });
    this.partner = { token: answer.access_token!, until: Date.now() + ((answer.expires_in ?? 28_800) - 300) * 1000 };
    return this.partner.token;
  }

  private async call(path: string, init: { method?: string; body?: unknown; partner?: boolean } = {}): Promise<unknown> {
    const token = init.partner ? await this.partnerToken() : await this.token();
    const resp = await fetch(`${FLEET_API}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await resp.json().catch(() => ({}))) as { response?: unknown; error?: string; error_description?: string };
    if (!resp.ok) throw new Error(`${path} ${resp.status}: ${body.error_description ?? body.error ?? ""}`.trim());
    return body.response ?? body;
  }

  /** Once per app and domain: Tesla reads the public key from the domain and lets the app call for its cars. */
  register(domain: string): Promise<unknown> {
    return this.call("/api/1/partner_accounts", { method: "POST", body: { domain }, partner: true });
  }

  async vehicles(): Promise<FleetVehicle[]> {
    const list = (await this.call("/api/1/vehicles")) as { id_s?: string; id?: number; vehicle_id?: number; vin?: string; display_name?: string; state?: string }[];
    return (Array.isArray(list) ? list : [])
      .filter((v) => v.vin)
      .map((v) => ({ id: v.id_s ?? String(v.id), vehicleId: v.vehicle_id ?? 0, vin: v.vin!, name: v.display_name ?? v.vin!, state: v.state ?? "" }));
  }

  /**
   * The car told where to stream and what: the configuration signed with
   * the app's key (Tesla.SS256), sent through Fleet API. The car takes it
   * only once the app's key is paired with it (tesla.com/_ak/<domain>).
   */
  configure(vins: string[], host: string, port: number, ca: string): Promise<unknown> {
    const config = {
      hostname: host,
      port,
      ca,
      // A year; set again from /admin before then.
      exp: Math.floor(Date.now() / 1000) + 365 * 86_400,
      fields: TELEMETRY_FIELDS,
      alert_types: ["service"],
      prefer_typed: true,
    };
    const token = signForFleet(this.key.scalar(), "TelemetryClient", config);
    return this.call("/api/1/vehicles/fleet_telemetry_config_jws", { method: "POST", body: { vins, token } });
  }

  /** Whether the car has the configuration (synced) and the key (key_paired). */
  telemetryState(vin: string): Promise<unknown> {
    return this.call(`/api/1/vehicles/${encodeURIComponent(vin)}/fleet_telemetry_config`);
  }

  /** What the cars reported trying to reach our server (a certificate refused, a host not found). */
  telemetryErrors(): Promise<unknown> {
    return this.call("/api/1/partner_accounts/fleet_telemetry_errors", { partner: true });
  }
}

async function tokenCall(form: Record<string, string>): Promise<TokenAnswer> {
  const resp = await fetch(FLEET_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const answer = (await resp.json().catch(() => ({}))) as TokenAnswer;
  if (!resp.ok || !answer.access_token) throw new Error(answer.error_description ?? answer.error ?? `Tesla 토큰 ${resp.status}`);
  return answer;
}

/** The value of one datum, whichever way the car typed it (prefer_typed, or the older strings). */
function valueOf(v: Record<string, unknown> | undefined): { num: number | null; raw: string | null; loc: { latitude: number; longitude: number } | null; text: string | null } {
  if (!v || v.invalid) return { num: null, raw: null, loc: null, text: null };
  for (const k of ["doubleValue", "floatValue", "intValue", "longValue"]) {
    if (v[k] != null) { const n = Number(v[k]); return { num: Number.isFinite(n) ? n : null, raw: String(v[k]), loc: null, text: null }; }
  }
  if (typeof v.stringValue === "string") {
    const n = Number(v.stringValue);
    return { num: v.stringValue !== "" && Number.isFinite(n) ? n : null, raw: v.stringValue, loc: null, text: v.stringValue };
  }
  if (v.locationValue && typeof v.locationValue === "object") return { num: null, raw: null, loc: v.locationValue as { latitude: number; longitude: number }, text: null };
  for (const [k, x] of Object.entries(v)) if (k.endsWith("Value") && typeof x === "string") return { num: null, raw: null, loc: null, text: x };
  return { num: null, raw: null, loc: null, text: null };
}

/** One record of the "V" type (transmit_decoded_records: JSON) as a sample. Only what it carries is set. */
export function parseTelemetry(json: string, odo = new OdoResolution()): { vin: string; sample: CarSample } | null {
  let p: { data?: { key?: string; value?: Record<string, unknown> }[]; createdAt?: string; vin?: string };
  try { p = JSON.parse(json); } catch { return null; }
  const t = Date.parse(p.createdAt ?? "");
  if (!p.vin || !Number.isFinite(t)) return null;
  const sample: CarSample = { t };
  let place: { latitude: number; longitude: number } | null = null;
  let heading: number | null = null;
  for (const d of p.data ?? []) {
    const v = valueOf(d.value);
    switch (d.key) {
      case "VehicleSpeed": sample.speedMps = v.num == null ? null : v.num * MPH_MPS; break;
      case "Odometer":
        if (v.num != null) { sample.odoM = v.num * MILE_M; sample.odoResM = odo.feed(v.raw ?? String(v.num)); }
        break;
      case "Gear":
        // Parked: standing, whatever the speed last said.
        if (v.text && /P$/.test(v.text) && sample.speedMps === undefined) sample.speedMps = null;
        break;
      case "Location": place = v.loc; break;
      case "GpsHeading": heading = v.num; break;
    }
  }
  if (place && Number.isFinite(place.latitude) && Number.isFinite(place.longitude)) sample.est = { lon: place.longitude, lat: place.latitude, heading };
  return { vin: p.vin, sample };
}

/**
 * The redis channels heard once for every car, each record handed to the
 * car's source while one is open. A car's connection events say whether it
 * is reaching our server at all.
 */
export class FleetFeed {
  private sub: RedisSubscriber | null = null;
  private open = new Map<string, FleetSource>();
  private odo = new Map<string, OdoResolution>();
  connected = new Map<string, boolean>();

  constructor(private redis: string, private log: (m: string) => void) {}

  get listening(): boolean {
    return this.sub?.connected ?? false;
  }

  get lastError(): string | null {
    return this.sub?.lastError ?? null;
  }

  source(vin: string, emit: (s: CarSample) => void, state: (st: string) => void): FleetSource {
    if (!this.sub) {
      const [host, port] = this.redis.split(":");
      this.sub = new RedisSubscriber(host, Number(port || 6379), `${NAMESPACE}_*`, (ch, payload) => this.message(ch, payload), this.log);
      this.sub.start();
    }
    return new FleetSource(vin, emit, state, this);
  }

  attach(s: FleetSource) { this.open.set(s.vin, s); }
  detach(s: FleetSource) { if (this.open.get(s.vin) === s) this.open.delete(s.vin); }

  private message(channel: string, payload: Buffer) {
    const vin = channel.match(/_\{([^}]+)\}$/)?.[1];
    if (!vin) return;
    const text = payload.toString("utf8");
    if (channel.startsWith(`${NAMESPACE}_connectivity_`)) {
      let status = "";
      try { status = (JSON.parse(text) as { status?: string }).status ?? ""; } catch { /* not JSON: not ours */ }
      this.connected.set(vin, status === "CONNECTED");
      this.open.get(vin)?.said(status === "CONNECTED" ? "connected" : "disconnected");
      return;
    }
    if (!channel.startsWith(`${NAMESPACE}_V_`)) return;
    let odo = this.odo.get(vin);
    if (!odo) this.odo.set(vin, (odo = new OdoResolution()));
    const got = parseTelemetry(text, odo);
    if (got) this.open.get(vin)?.sample(got.sample);
  }
}

export class FleetSource implements CarSource {
  state = "waiting";
  lastError: string | null = null;
  lastSampleAt = 0;

  constructor(readonly vin: string, private emit: (s: CarSample) => void, private onState: (st: string) => void, private feed: FleetFeed) {}

  start() { this.feed.attach(this); this.said(this.feed.connected.get(this.vin) ? "connected" : "waiting"); }
  stop() { this.feed.detach(this); this.said("stopped"); }

  said(state: string) {
    if (state === this.state) return;
    this.state = state;
    this.onState(state);
  }

  sample(s: CarSample) {
    this.lastSampleAt = Date.now();
    this.said("streaming");
    this.emit(s);
  }
}

/** The certificate chain the car is to trust for our telemetry server: the file beside its certificate. */
export function telemetryCa(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}
