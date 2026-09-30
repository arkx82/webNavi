import { test } from "node:test";
import assert from "node:assert/strict";
import { Lockout, RateLimit, RefusedUrl, isPrivate, isPublicUrl, publicLookup, unmapped } from "./guard.js";

test("addresses inside the house, or no one's, are private", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:192.168.1.42"]) assert.ok(isPrivate(ip), ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111"]) assert.ok(!isPrivate(ip), ip);
});

test("an IPv4 address inside IPv6 is seen as the IPv4 it is, in every spelling", () => {
  assert.equal(unmapped("::ffff:192.168.1.42"), "192.168.1.42");
  assert.equal(unmapped("::ffff:7f00:1"), "127.0.0.1");
  assert.equal(unmapped("[::FFFF:C0A8:12A]"), "192.168.1.42");
  assert.equal(unmapped("0:0:0:0:0:ffff:a00:1"), "10.0.0.1");
  assert.equal(unmapped("64:ff9b::7f00:1"), "127.0.0.1");
  assert.equal(unmapped("2606:4700::1111"), "2606:4700::1111", "a plain IPv6 address is left alone");
  assert.equal(unmapped("8.8.8.8"), "8.8.8.8");
  for (const ip of ["::ffff:7f00:1", "::ffff:c0a8:12a", "64:ff9b::7f00:1", "::ffff:a9fe:a9fe", "[::ffff:127.0.0.1]"]) assert.ok(isPrivate(ip), ip);
  for (const ip of ["::ffff:808:808", "64:ff9b::101:101"]) assert.ok(!isPrivate(ip), ip);
});

test("the stream relay refuses the house by name or number, and anything not http", async () => {
  for (const u of ["http://192.168.1.1/", "http://localhost:8080/", "http://127.0.0.1:2375/", "http://router.local/", "file:///etc/passwd", "http://[::1]/"]) {
    assert.equal(await isPublicUrl(new URL(u)), false, u);
  }
});

test("the house written as IPv4 inside IPv6, as the URL parser spells it, is refused too", async () => {
  for (const u of ["http://[::ffff:7f00:1]/", "http://[::ffff:c0a8:12a]/", "http://[64:ff9b::7f00:1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:169.254.169.254]/"]) {
    assert.equal(await isPublicUrl(new URL(u)), false, u);
  }
});

test("the relay's own lookup gives no address for a name that resolves into the house", async () => {
  const found = await new Promise<{ err: Error | null; addresses: unknown }>((done) => publicLookup("localhost", { all: true }, (err, addresses) => done({ err, addresses })));
  assert.ok(found.err instanceof RefusedUrl, String(found.err));
  assert.deepEqual(found.addresses, []);
});

test("five wrong logins lock the account whatever address the next try claims, and the address whatever name", () => {
  const lock = new Lockout(5, 60_000);
  const t = Date.parse("2026-09-30T00:00:00Z");
  for (let i = 0; i < 5; i++) lock.failed(["ip:1.2.3.4", "name:june"], t);
  assert.equal(lock.wait(["ip:1.2.3.4", "name:june"], t), 60);
  assert.equal(lock.wait(["ip:5.6.7.8", "name:june"], t + 30_000), 30, "a forged address does not free the account");
  assert.equal(lock.wait(["ip:1.2.3.4", "name:mina"], t), 60, "nor a new name the address");
  assert.equal(lock.wait(["ip:5.6.7.8", "name:mina"], t), 0);
  assert.equal(lock.wait(["ip:1.2.3.4", "name:june"], t + 61_000), 0, "a minute later");
  lock.passed(["ip:1.2.3.4", "name:june"]);
  lock.failed(["ip:1.2.3.4", "name:june"], t);
  assert.equal(lock.wait(["ip:1.2.3.4", "name:june"], t), 0, "a right login starts the count over");
});

test("old failures are let go, and the map never grows past its cap", () => {
  const lock = new Lockout(5, 60_000, 100);
  const t = Date.parse("2026-09-30T00:00:00Z");
  lock.failed(["ip:old"], t);
  lock.failed(["ip:new"], t + 10 * 60_000);
  assert.equal(lock.size, 1, "the one from ten minutes ago is gone");
  for (let i = 0; i < 300; i++) lock.failed([`ip:${i}`], t + 10 * 60_000);
  assert.ok(lock.size <= 100, `${lock.size}`);
  assert.equal(lock.wait(["ip:299"], t + 10 * 60_000), 0);
  lock.failed(["ip:299"], t + 10 * 60_000);
  lock.failed(["ip:299"], t + 10 * 60_000);
  lock.failed(["ip:299"], t + 10 * 60_000);
  lock.failed(["ip:299"], t + 10 * 60_000);
  assert.equal(lock.wait(["ip:299"], t + 10 * 60_000), 60, "the newest is still counted");
});

test("a user past the minute's allowance is refused until the next minute", () => {
  const limit = new RateLimit();
  const t = Date.parse("2026-09-30T00:00:10Z");
  let ok = 0;
  for (let i = 0; i < 130; i++) if (limit.allow("1", "/api/safety/near", t)) ok++;
  assert.equal(ok, 120);
  assert.ok(limit.allow("2", "/api/safety/near", t), "another user is not held up");
  assert.ok(limit.allow("1", "/api/safety/near", t + 60_000), "a new minute");
});
