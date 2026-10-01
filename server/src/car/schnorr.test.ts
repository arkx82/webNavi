import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetKey, deterministicNonce, schnorrSign, signForFleet } from "./schnorr.js";

// The vectors are vehicle-command's own (internal/schnorr/*_test.go).
const testKey = () => { const k = Buffer.alloc(32); k[0] = 3; return k; };

test("the nonce is RFC 6979's (appendix A.2.5)", () => {
  const scalar = Buffer.from("c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721", "hex");
  const nonce = deterministicNonce(scalar, createHash("sha256").update("sample").digest());
  assert.equal(nonce.toString("hex"), "a6e3c57dd01abe90086538398355dd4c3b17aa873382b0f24d6129493d8aad60");
});

test("a first candidate past the order is sampled again", () => {
  const digest = Buffer.from("0080c36864c5f2f460e3767983c65677b65cef901bcedcb223f9b365c68f52f6", "hex");
  assert.equal(deterministicNonce(testKey(), digest).toString("hex"), "264fc6592fbea24fd0954e0b86b886e8743161758ddad2f7e9fed75a0019e005");
});

test("the signature is vehicle-command's, byte for byte", () => {
  const want =
    "7cfdbeb5baa730540401550bdefa2097" + "6453e8539ae4b2f26ce33125801a08f9" + "0ed20c3d846497ff82cc9772e3db4703" +
    "982f47bd0b0b89dfb9a49cd2e5240546" + "02b1e05fbf95f5686faea7a5809eb92f" + "5ecc22eae74ceccc5e2a65dd67ff20fc";
  assert.equal(schnorrSign(testKey(), Buffer.from("hello world")).toString("hex"), want);
});

test("a fleet JWT names the key as issuer and the telemetry client as audience", () => {
  const jwt = signForFleet(testKey(), "TelemetryClient", { hostname: "t.example.com", aud: "ignored" });
  const [head, body, sig] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url").toString()), { alg: "Tesla.SS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.equal(claims.aud, "com.tesla.fleet.TelemetryClient");
  assert.equal(claims.hostname, "t.example.com");
  assert.equal(Buffer.from(claims.iss, "base64").length, 65);
  assert.equal(Buffer.from(sig, "base64url").length, 96);
});

test("the key is made once and kept; its public half is a PEM", () => {
  const file = join(mkdtempSync(join(tmpdir(), "fleet-key-")), "tesla", "fleet-key.pem");
  const a = new FleetKey(file), b = new FleetKey(file);
  assert.equal(a.scalar().length, 32);
  assert.equal(a.publicPem(), b.publicPem());
  assert.match(a.publicPem(), /^-----BEGIN PUBLIC KEY-----/);
});
