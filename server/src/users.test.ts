import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.js";
import { Settings } from "./settings.js";
import { parseSession, registerUsers } from "./users.js";

async function site() {
  const dir = mkdtempSync(join(tmpdir(), "webnavi-users-"));
  const db = new Db(dir);
  db.addUser("june", "secret1");
  const app = Fastify();
  registerUsers(app, db, new Settings(dir, {}), async () => {}, dir);
  await app.ready();
  return { app, dir };
}
const login = (app: Awaited<ReturnType<typeof site>>["app"], name: string, password: string, ip = "8.8.8.8") =>
  app.inject({ method: "POST", url: "/api/login", payload: { name, password }, headers: { "cf-connecting-ip": ip }, remoteAddress: "127.0.0.1" });

test("a session cookie that is not even well-formed names no one", () => {
  assert.equal(parseSession(undefined), null);
  assert.equal(parseSession("other=1"), null);
  assert.equal(parseSession("nav_user=%E0%A4%A"), null, "a bad escape is not a 500");
  assert.equal(parseSession("nav_user=nosig"), null);
  assert.deepEqual(parseSession("a=1; nav_user=1.0.99~abc"), ["1.0.99", "abc"]);
});

test("a bad cookie on an /api call is a 401, not a crash", async () => {
  const { app } = await site();
  const r = await app.inject({ method: "GET", url: "/api/me/data", headers: { cookie: "nav_user=%E0%A4%A" } });
  assert.equal(r.statusCode, 401);
});

test("five wrong passwords lock the account, whatever address the tunnel header claims after", async () => {
  const { app } = await site();
  for (let i = 0; i < 5; i++) assert.equal((await login(app, "june", "wrong!!", "1.1.1.1")).statusCode, 401);
  assert.equal((await login(app, "june", "secret1", "1.1.1.1")).statusCode, 429);
  assert.equal((await login(app, "june", "secret1", "2.2.2.2")).statusCode, 429, "a forged address does not free the account");
  assert.equal((await login(app, "JUNE ", "secret1", "3.3.3.3")).statusCode, 429, "nor another spelling of the name");
  assert.equal((await login(app, "mina", "secret1", "1.1.1.1")).statusCode, 429, "the address is held too");
  assert.equal((await login(app, "mina", "secret1", "4.4.4.4")).statusCode, 401, "another name from another address is only wrong");
});

test("the page's log goes to a file a day, and is refused when the day's file is full", async () => {
  const { app, dir } = await site();
  const cookie = (await login(app, "june", "secret1")).headers["set-cookie"] as string;
  const r = await app.inject({ method: "POST", url: "/api/me/log", payload: { lines: ["one", "two\nthree", 3] }, headers: { cookie } });
  assert.equal(r.statusCode, 200);
  const files = readdirSync(join(dir, "client-logs"));
  assert.equal(files.length, 1);
  assert.ok(/^june-\d{4}-\d{2}-\d{2}\.log$/.test(files[0]), files[0]);
  assert.equal(readFileSync(join(dir, "client-logs", files[0]), "utf8"), "one\ntwo three\n");
  // 900 KB a post, under Fastify's 1 MiB body: the sixth takes the day past 5 MB, the seventh is refused.
  const big = { lines: Array.from({ length: 2000 }, () => "x".repeat(450)) };
  for (let i = 0; i < 6; i++) assert.equal((await app.inject({ method: "POST", url: "/api/me/log", payload: big, headers: { cookie } })).statusCode, 200, `post ${i}`);
  assert.equal((await app.inject({ method: "POST", url: "/api/me/log", payload: big, headers: { cookie } })).statusCode, 413);
});

test("the music player's calls are gated like the rest: no session, no TIDAL token, audio or proxy; the state alone is open", async () => {
  const { app } = await site();
  for (const url of ["/api/music/tidal/token", "/api/music/tidal/track/1/audio", "/api/music/tidal/v1/users/1/favorites/tracks"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401, url);
  }
  assert.notEqual((await app.inject({ method: "GET", url: "/api/music/state" })).statusCode, 401);
});

test("a login body of the wrong shape is a 400, not a crash", async () => {
  const { app } = await site();
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { name: 123, password: ["x"] }, remoteAddress: "127.0.0.1" });
  assert.equal(r.statusCode, 400);
});
