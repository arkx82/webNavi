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
  adminHash?: string;
}

export type SecretName = keyof Secrets;

const ENV: Record<SecretName, string | undefined> = {
  tmapAppKey: "TMAP_APP_KEY",
  kakaoRestKey: "KAKAO_REST_KEY",
  naverClientId: "NAVER_CLIENT_ID",
  naverClientSecret: "NAVER_CLIENT_SECRET",
  dashscopeApiKey: "DASHSCOPE_API_KEY",
  ttsVoice: "TTS_VOICE",
  adminHash: undefined,
};

/** The fields the page edits, in the order it shows them. */
export const EDITABLE: SecretName[] = ["tmapAppKey", "kakaoRestKey", "naverClientId", "naverClientSecret", "dashscopeApiKey", "ttsVoice"];

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
    return envName ? this.env[envName] || undefined : undefined;
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
  masked(): Record<string, { set: boolean; from: "saved" | "env" | null; hint: string }> {
    const out: Record<string, { set: boolean; from: "saved" | "env" | null; hint: string }> = {};
    for (const name of EDITABLE) {
      const saved = this.saved[name];
      const value = this.get(name);
      out[name] = {
        set: !!value,
        from: saved ? "saved" : value ? "env" : null,
        hint: value ? (name === "ttsVoice" ? value : "…" + value.slice(-4)) : "",
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
