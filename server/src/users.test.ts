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

test("the drive's trace goes beside the log, a route a line however long", async () => {
  const { app, dir } = await site();
  const cookie = (await login(app, "june", "secret1")).headers["set-cookie"] as string;
  const route = `r,1,${JSON.stringify({ path: Array.from({ length: 20_000 }, (_, i) => [127 + i / 1e5, 37.5]) })}`;
  const r = await app.inject({ method: "POST", url: "/api/me/log", payload: { lines: [], trace: ["f,1,1,127,37.5,5,10,90", route] }, headers: { cookie } });
  assert.equal(r.statusCode, 200);
  const files = readdirSync(join(dir, "client-logs"));
  assert.deepEqual(files.map((f) => f.replace(/\d{4}-\d{2}-\d{2}/, "D")), ["june-D.trace"], "no empty log made");
  const rows = readFileSync(join(dir, "client-logs", files[0]), "utf8").trim().split("\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[1], route, "the route whole");
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

test("the browser's reports (a crash, with the page's context) go to the user's log of the day", async () => {
  const { app, dir } = await site();
  const cookie = (await login(app, "june", "secret1")).headers["set-cookie"] as string;
  const body = JSON.stringify([{ type: "crash", url: "https://navi.example/?x", age: 4200, body: { is_top_level: true, crash_report_api: { state: "메모리 42/113 MB", log: "a\nb" } } }]);
  const r = await app.inject({ method: "POST", url: "/api/report", payload: body, headers: { cookie, "content-type": "application/reports+json" } });
  assert.equal(r.statusCode, 204);
  const files = readdirSync(join(dir, "client-logs"));
  const text = readFileSync(join(dir, "client-logs", files[0]), "utf8");
  assert.equal(text.trim().split("\n").length, 1, "one line, the context's own line breaks kept inside it");
  assert.match(text, /브라우저 보고 crash \/\?x 4200ms 전 .*메모리 42\/113 MB/);
  assert.equal((await app.inject({ method: "POST", url: "/api/report", payload: body, headers: { "content-type": "application/reports+json" } })).statusCode, 401);
});

test("지금 운행 중: a car page's word in a few words — moving, standing while guided, open, or closed — and never where", async () => {
  const { presenceWord } = await import("./users.js");
  const now = 1_800_000_000_000;
  const p = (o: object) => ({ at: now - 10_000, gone: false, kmh: null, guiding: false, sim: false, leftS: null, ...o });
  assert.deepEqual(presenceWord(p({ kmh: 42, guiding: true, leftS: 1500 }), null, now), { state: "driving", text: "운행 중 · 42 km/h · 안내 중 · 도착까지 25분" });
  assert.deepEqual(presenceWord(p({ kmh: 38 }), null, now), { state: "driving", text: "운행 중 · 38 km/h" });
  assert.deepEqual(presenceWord(p({ kmh: 0, guiding: true, leftS: 4000 }), null, now), { state: "stopped", text: "정차 중 · 안내 중 · 도착까지 1시간 7분" });
  assert.deepEqual(presenceWord(p({ kmh: 60, sim: true }), null, now), { state: "driving", text: "모의 주행 중 · 60 km/h" });
  assert.deepEqual(presenceWord(p({ kmh: null }), null, now), { state: "open", text: "화면 켜짐 · 정지" });
  assert.deepEqual(presenceWord(p({ at: now - 120_000, kmh: 50 }), null, now), { state: "off", text: "꺼짐 · 마지막 접속 2분 전" }, "not heard from in 90 s");
  assert.deepEqual(presenceWord(p({ gone: true }), now - 3_600_000, now), { state: "off", text: "꺼짐 · 마지막 접속 10초 전" });
  assert.deepEqual(presenceWord(undefined, null, now), { state: "off", text: "접속한 적 없음" });
});
