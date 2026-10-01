import { createECDH, createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Tesla's "Tesla.SS256": Schnorr signatures over P-256 with SHA-256 and an
 * RFC 6979 nonce, as teslamotors/vehicle-command signs a Fleet Telemetry
 * configuration for the car (internal/schnorr). Ported here so the server
 * signs it itself, without running Tesla's command proxy beside it.
 */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/** The curve's base point, uncompressed. */
const G = Buffer.from(
  "04" +
  "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" +
  "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
  "hex",
);

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
const hmac = (key: Buffer, ...parts: Buffer[]) => { const h = createHmac("sha256", key); for (const p of parts) h.update(p); return h.digest(); };
const toInt = (b: Buffer) => BigInt(`0x${b.toString("hex") || "0"}`);
const toBytes = (n: bigint) => Buffer.from(n.toString(16).padStart(64, "0"), "hex");
const mod = (n: bigint) => ((n % N) + N) % N;

/** RFC 6979's nonce for P-256/SHA-256, step for step as vehicle-command has it. */
export function deterministicNonce(scalar: Buffer, digest: Buffer): Buffer {
  let v = Buffer.alloc(32, 0x01);
  let k = Buffer.alloc(32, 0x00);
  const h1 = toBytes(mod(toInt(digest)));
  k = hmac(k, v, Buffer.from([0x00]), scalar, h1);
  v = hmac(k, v);
  k = hmac(k, v, Buffer.from([0x01]), scalar, h1);
  v = hmac(k, v);
  for (;;) {
    v = hmac(k, v);
    const n = toInt(v);
    if (n > 0n && n < N) return v;
    k = hmac(k, v, Buffer.from([0x00]));
    v = hmac(k, v);
  }
}

/** The public point of a scalar, uncompressed (65 bytes). */
function publicOf(scalar: Buffer): Buffer {
  const e = createECDH("prime256v1");
  e.setPrivateKey(scalar);
  return e.getPublicKey();
}

function lengthValue(b: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
}

function challenge(publicNonce: Buffer, senderPublic: Buffer, message: Buffer): Buffer {
  return sha256(Buffer.concat([lengthValue(G), lengthValue(publicNonce), lengthValue(senderPublic), lengthValue(message)]));
}

/** The 96-byte signature (V's x and y, then r) of [message] by the private [scalar]. */
export function schnorrSign(scalar: Buffer, message: Buffer): Buffer {
  const nonce = deterministicNonce(scalar, sha256(message));
  const publicNonce = publicOf(nonce);
  const c = toInt(challenge(publicNonce, publicOf(scalar), message));
  const r = mod(toInt(nonce) - mod(toInt(scalar) * c));
  return Buffer.concat([publicNonce.subarray(1), toBytes(r)]);
}

/** A JWT signed Tesla.SS256 for every car that trusts the key ("com.tesla.fleet.<app>"), as SignMessageForFleet makes it. */
export function signForFleet(scalar: Buffer, app: string, claims: Record<string, unknown>): string {
  const body = { ...claims, iss: publicOf(scalar).toString("base64"), aud: `com.tesla.fleet.${app}` };
  const head = Buffer.from(JSON.stringify({ alg: "Tesla.SS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  const signing = `${head}.${payload}`;
  return `${signing}.${schnorrSign(scalar, Buffer.from(signing)).toString("base64url")}`;
}

/**
 * The app's key pair, made once and kept (0600) beside the settings: the
 * private half signs, the public half is served at
 * /.well-known/appspecific/com.tesla.3p.public-key.pem for Tesla and the car.
 */
export class FleetKey {
  private key: KeyObject | null = null;

  constructor(private file: string) {}

  private load(): KeyObject {
    if (this.key) return this.key;
    if (!existsSync(this.file)) {
      mkdirSync(dirname(this.file), { recursive: true });
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      writeFileSync(this.file, privateKey.export({ type: "sec1", format: "pem" }), { mode: 0o600 });
    }
    chmodSync(this.file, 0o600);
    this.key = createPrivateKey(readFileSync(this.file, "utf8"));
    return this.key;
  }

  /** The private scalar, 32 bytes. */
  scalar(): Buffer {
    const d = this.load().export({ format: "jwk" }).d;
    if (!d) throw new Error("fleet key: not an EC private key");
    return Buffer.from(d, "base64url");
  }

  publicPem(): string {
    return createPublicKey(this.load()).export({ type: "spki", format: "pem" }).toString();
  }
}
