import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the admin page saves: the keys, the voice, the admin password's
 * hash. Kept encrypted (AES-256-GCM) under a master key the server makes
 * on first run and keeps beside the file at 0600. So a backup or a copied
 * volume gives nothing away without the other file; root on the box, of
 * course, has both — that is the level of the promise.
 *
 * Environment variables are the fallback for any field left unset, so
 * the old .env way keeps working and the page can take over one key at
 * a time.
 */
export interface Secrets {
  tmapAppKey?: string;
  kakaoRestKey?: string;
  naverClientId?: string;
  naverClientSecret?: string;
  dashscopeApiKey?: string;
  ttsVoice?: string;
  /** 오피넷 (fuel prices) and data.go.kr (chargers), and the owner's own charger rates. */
  opinetKey?: string;
  dataGoKrKey?: string;
  evTariffs?: string;
  /** 한국도로공사 (data.ex.co.kr: rest areas, bus lanes) and ITS 국가교통정보센터 (incidents). */
  exKey?: string;
  itsKey?: string;
  /** 서울 열린데이터광장 (data.seoul.go.kr): Seoul's own traffic lights, which the national standard data lacks. */
  seoulKey?: string;
  adminHash?: string;
  /** TIDAL: the app's client, and the owner's refresh token once connected. */
  tidalClientId?: string;
  tidalClientSecret?: string;
  tidalRefresh?: string;
  tidalUserId?: string;
  tidalCountryCode?: string;
}

export type SecretName = keyof Secrets;

export const DEFAULT_TIDAL_CLIENT_ID = "fX2JxdmntZWK0ixT";
export const DEFAULT_TIDAL_CLIENT_SECRET = "1Nn9AfDAjxrgJFJbKNWLeAyKGVGmINuXPPLHVXAvxAg=";

const ENV: Record<SecretName, string | undefined> = {
  tmapAppKey: "TMAP_APP_KEY",
  kakaoRestKey: "KAKAO_REST_KEY",
  naverClientId: "NAVER_CLIENT_ID",
  naverClientSecret: "NAVER_CLIENT_SECRET",
  dashscopeApiKey: "DASHSCOPE_API_KEY",
  ttsVoice: "TTS_VOICE",
  opinetKey: "OPINET_KEY",
  dataGoKrKey: "DATA_GO_KR_KEY",
  evTariffs: "EV_TARIFFS",
  exKey: "EX_API_KEY",
  itsKey: "ITS_API_KEY",
  seoulKey: "SEOUL_API_KEY",
  adminHash: undefined,
  tidalClientId: "TIDAL_CLIENT_ID",
  tidalClientSecret: "TIDAL_CLIENT_SECRET",
  tidalRefresh: undefined,
  tidalUserId: undefined,
  tidalCountryCode: undefined,
};

/** The fields the page edits, in the order it shows them. */
export const EDITABLE: SecretName[] = [
  "tmapAppKey", "kakaoRestKey", "naverClientId", "naverClientSecret", "dashscopeApiKey", "ttsVoice",
  "opinetKey", "dataGoKrKey", "evTariffs",
  "exKey", "itsKey", "seoulKey",
  "tidalClientId", "tidalClientSecret",
];

export class Settings {
  private readonly master: Buffer;
  private readonly file: string;
  private saved: Secrets = {};

  constructor(dir: string, private env: NodeJS.ProcessEnv = process.env) {
    mkdirSync(dir, { recursive: true });
    const keyFile = join(dir, "master.key");
    if (!existsSync(keyFile)) {
      writeFileSync(keyFile, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    }
    chmodSync(keyFile, 0o600);
    this.master = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
    if (this.master.length !== 32) throw new Error(`${keyFile} is not a 32-byte hex key`);
    this.file = join(dir, "settings.enc");
    if (existsSync(this.file)) this.saved = this.decrypt(readFileSync(this.file, "utf8"));
  }

  /** The value in force: saved on the page, else from the environment. */
  get(name: SecretName): string | undefined {
    const saved = this.saved[name];
    if (saved) return saved;
    const envName = ENV[name];
    const envVal = envName ? this.env[envName] || undefined : undefined;
    if (envVal) return envVal;
    if (name === "tidalClientId") return DEFAULT_TIDAL_CLIENT_ID;
    if (name === "tidalClientSecret") return DEFAULT_TIDAL_CLIENT_SECRET;
    return undefined;
  }

  /** A getter bound to one field, for a provider to read at call time. */
  reader(name: SecretName): () => string | undefined {
    return () => this.get(name);
  }

  /** Merges [patch] in; an empty string clears the saved value (the env fallback returns). */
  set(patch: Partial<Secrets>) {
    for (const [k, v] of Object.entries(patch) as [SecretName, string | undefined][]) {
      if (v == null) continue;
      if (v === "") delete this.saved[k];
      else this.saved[k] = v;
    }
    writeFileSync(this.file, this.encrypt(this.saved), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  /** For the page: whether each field has a value, where from, and its last characters. */
  masked(): Record<string, { set: boolean; from: "saved" | "env" | "default" | null; hint: string }> {
    const out: Record<string, { set: boolean; from: "saved" | "env" | "default" | null; hint: string }> = {};
    for (const name of EDITABLE) {
      const saved = this.saved[name];
      const envName = ENV[name];
      const envVal = envName ? this.env[envName] || undefined : undefined;
      const value = this.get(name);
      const isDefault = !saved && !envVal && (name === "tidalClientId" || name === "tidalClientSecret");
      out[name] = {
        set: !!value,
        from: saved ? "saved" : envVal ? "env" : isDefault ? "default" : null,
        hint: isDefault ? "기본 내장 키 (…" + value!.slice(-4) + ")" : value ? (name === "ttsVoice" || name === "evTariffs" ? value : "…" + value.slice(-4)) : "",
      };
    }
    return out;
  }

  // ---- the admin password ----

  get hasPassword() {
    return !!this.saved.adminHash;
  }

  setPassword(password: string) {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 32);
    this.set({ adminHash: `${salt.toString("hex")}:${hash.toString("hex")}` });
  }

  checkPassword(password: string): boolean {
    const kept = this.saved.adminHash;
    if (!kept) return false;
    const [salt, hash] = kept.split(":");
    const tried = scryptSync(password, Buffer.from(salt, "hex"), 32);
    return timingSafeEqual(tried, Buffer.from(hash, "hex"));
  }

  // ---- a signed token for the session cookie ----

  sign(text: string): string {
    return createHmac("sha256", this.master).update(text).digest("base64url");
  }

  verify(text: string, signature: string): boolean {
    const want = Buffer.from(this.sign(text));
    const got = Buffer.from(signature);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  // ---- the file ----

  private encrypt(secrets: Secrets): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.master, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${body.toString("base64")}\n`;
  }

  private decrypt(text: string): Secrets {
    const [v, iv, tag, body] = text.trim().split(".");
    if (v !== "v1") throw new Error("settings.enc: unknown format");
    const decipher = createDecipheriv("aes-256-gcm", this.master, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as Secrets;
  }
}
