import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdmin } from "./admin.js";
import { Db } from "./db.js";
import { registerMusic } from "./music.js";
import { Settings } from "./settings.js";
import { registerUsers } from "./users.js";

async function site() {
  const dir = mkdtempSync(join(tmpdir(), "webnavi-admin-"));
  const db = new Db(dir);
  const june = db.addUser("june", "secret1");
  db.setRole(june.id, "admin");
  db.addUser("test", "secret2");
  const settings = new Settings(dir, {});
  settings.setPassword("page-password");
  settings.set({ tidalOwners: JSON.stringify({ june: { refresh: "R-june", userId: "1", countryCode: "KR" }, test: { refresh: "R-test", userId: "2", countryCode: "KR" } }) });
  const page = join(dir, "admin.html");
  writeFileSync(page, "<!doctype html>");
  const app = Fastify();
  const admin = registerAdmin(app, settings, { test: async () => ({}), prerender: async () => ({ made: 0, had: 0 }), status: () => ({}) }, page, db);
  const music = registerMusic(app, settings, db, admin);
  registerUsers(app, db, settings, admin.adminGuard, dir, admin.selfGuard, (name) => music.forget(name));
  await app.ready();
  /** The cookies an /admin login gives, as a header to send back. */
  const login = async (name: string, password: string) => {
    const r = await app.inject({ method: "POST", url: "/admin/api/login", payload: { name, password }, headers: { "cf-connecting-ip": "8.8.8.8" }, remoteAddress: "127.0.0.1" });
    const set = r.headers["set-cookie"];
    return { status: r.statusCode, cookie: (Array.isArray(set) ? set : set ? [set] : []).map((c) => String(c).split(";")[0]).join("; ") };
  };
  const call = (cookie: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie, "x-requested-with": "nav-admin" } });
  return { app, login, call };
}

test("/admin takes an account's 아이디 and 비밀번호, and the page's own password as admin", async () => {
  const { login, call } = await site();
  assert.equal((await login("june", "wrong")).status, 401);
  const june = await login("june", "secret1");
  assert.equal(june.status, 200);
  assert.match(june.cookie, /nav_user=/, "the account's own session, the car page's too");
  assert.deepEqual((await call(june.cookie, "GET", "/admin/api/state")).json(), { needsSetup: false, loggedIn: true, who: "june", admin: true, builtin: false });

  const builtin = await login("admin", "page-password");
  assert.equal(builtin.status, 200);
  assert.match(builtin.cookie, /nav_admin=/);
  assert.equal((await call(builtin.cookie, "GET", "/admin/api/state")).json().admin, true);
  assert.equal((await login("", "page-password")).status, 200, "the page's password alone, as before");
  assert.equal((await login("test", "page-password")).status, 401, "not an account's way in");
});

test("a 사용자 on /admin sets only what is theirs: their TIDAL, their password; the keys and the users are refused", async () => {
  const { login, call } = await site();
  const me = await login("test", "secret2");
  assert.equal(me.status, 200);
  const state = (await call(me.cookie, "GET", "/admin/api/state")).json();
  assert.equal(state.who, "test");
  assert.equal(state.admin, false);

  for (const [method, url] of [["GET", "/admin/api/settings"], ["GET", "/admin/api/users"], ["POST", "/admin/api/settings"], ["POST", "/admin/api/test"]] as const) {
    assert.equal((await call(me.cookie, method, url, method === "POST" ? {} : undefined)).statusCode, 403, `${method} ${url}`);
  }
  // Their own TIDAL only: the list has them alone, another's cannot be undone, their own can.
  assert.deepEqual((await call(me.cookie, "GET", "/admin/music/state")).json().tidal.map((o: { name: string }) => o.name), ["test"]);
  assert.equal((await call(me.cookie, "POST", "/admin/music/tidal/disconnect", { user: "june" })).statusCode, 403);
  assert.equal((await call(me.cookie, "POST", "/admin/music/tidal/disconnect", {})).statusCode, 200, "with none named: their own");

  // Their password, the old one asked first; the session goes on in this browser.
  assert.equal((await call(me.cookie, "POST", "/admin/api/me/password", { current: "nope", password: "newpass1" })).statusCode, 401);
  const changed = await call(me.cookie, "POST", "/admin/api/me/password", { current: "secret2", password: "newpass1" });
  assert.equal(changed.statusCode, 200);
  const fresh = String(changed.headers["set-cookie"]).split(";")[0];
  assert.equal((await call(fresh, "GET", "/admin/api/state")).json().who, "test");
  assert.equal((await call(me.cookie, "GET", "/admin/api/state")).json().loggedIn, false, "the old session ends");
  assert.equal((await login("test", "newpass1")).status, 200);
});

test("a 관리자 sees every account's link as a line, and changes their own only; a deleted account's link goes with it", async () => {
  const { login, call } = await site();
  const june = await login("june", "secret1");
  // A line an account, as the page shows it.
  const lines = async () => (await call(june.cookie, "GET", "/admin/music/state")).json().tidal.map((o: { line: string }) => o.line);
  assert.deepEqual(await lines(), ["june — TIDAL 연결됨 (KR) · 서버 시작 뒤 아직 안 씀", "test — TIDAL 연결됨 (KR) · 서버 시작 뒤 아직 안 씀"]);
  assert.equal((await call(june.cookie, "POST", "/admin/music/tidal/disconnect", { user: "test" })).statusCode, 403, "another's is theirs");
  assert.equal((await call(june.cookie, "POST", "/admin/music/tidal/check", { user: "test", deviceCode: "x" })).statusCode, 403);
  assert.equal((await lines())[1], "test — TIDAL 연결됨 (KR) · 서버 시작 뒤 아직 안 씀");
  // The built-in admin has no account: no link of its own to change.
  const builtin = await login("admin", "page-password");
  assert.equal((await call(builtin.cookie, "POST", "/admin/music/tidal/disconnect", {})).statusCode, 403);
  // An account deleted: its TIDAL goes; a new one of the name starts with none.
  const users = (await call(june.cookie, "GET", "/admin/api/users")).json().users as { id: number; name: string }[];
  const test = users.find((u) => u.name === "test")!;
  assert.equal((await call(june.cookie, "DELETE", `/admin/api/users/${test.id}`)).statusCode, 200);
  assert.deepEqual(await lines(), ["june — TIDAL 연결됨 (KR) · 서버 시작 뒤 아직 안 씀"]);
  assert.equal((await call(june.cookie, "POST", "/admin/api/users", { name: "test", password: "secret3" })).statusCode, 200);
  assert.equal((await lines())[1], "test — 연결 안 됨 (차 화면에 음악 버튼 없음)");
});
