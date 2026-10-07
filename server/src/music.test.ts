import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.js";
import { Settings } from "./settings.js";
import { registerUsers } from "./users.js";
import { registerMusic } from "./music.js";

async function site() {
  const dir = mkdtempSync(join(tmpdir(), "webnavi-music-"));
  const db = new Db(dir);
  const admin = db.addUser("admin", "secret1");
  db.setRole(admin.id, "admin");
  const june = db.addUser("june", "secret1");
  db.setRole(june.id, "admin");
  db.addUser("friend", "secret1");
  const settings = new Settings(dir, {});
  // The site's one TIDAL login of before, and june's Tesla.
  settings.set({ tidalRefresh: "R-old", tidalUserId: "42", tidalCountryCode: "KR", teslaOwners: JSON.stringify({ june: "T" }) });
  const app = Fastify();
  registerMusic(app, settings, db, async () => {});
  registerUsers(app, db, settings, async () => {}, dir);
  await app.ready();
  const cookieOf = async (name: string) => {
    const r = await app.inject({ method: "POST", url: "/api/login", payload: { name, password: "secret1" }, headers: { "cf-connecting-ip": "8.8.8.8" }, remoteAddress: "127.0.0.1" });
    return String(r.headers["set-cookie"]).split(";")[0];
  };
  return { app, settings, cookieOf };
}

test("TIDAL is an account's own: the one login of before goes to the account with the Tesla, and no other sees it", async () => {
  const { app, settings, cookieOf } = await site();
  assert.equal(settings.get("tidalRefresh") ?? "", "", "the site-wide login is moved, not kept");
  assert.deepEqual(JSON.parse(settings.get("tidalOwners")!), { june: { refresh: "R-old", userId: "42", countryCode: "KR" } });

  const june = await cookieOf("june"), friend = await cookieOf("friend");
  const state = async (cookie?: string) => (await app.inject({ method: "GET", url: "/api/music/state", headers: cookie ? { cookie } : {} })).json().tidal.connected;
  assert.equal(await state(june), true);
  assert.equal(await state(friend), false);
  assert.equal(await state(), false, "not logged in: none");

  // Another account's player is refused before any call to TIDAL.
  const token = await app.inject({ method: "GET", url: "/api/music/tidal/token", headers: { cookie: friend } });
  assert.equal(token.statusCode, 404);
  const list = await app.inject({ method: "GET", url: "/api/music/tidal/v1/users/42/playlists", headers: { cookie: friend } });
  assert.equal(list.statusCode, 401);

  const admin = (await app.inject({ method: "GET", url: "/admin/music/state" })).json().tidal as { name: string; connected: boolean }[];
  assert.deepEqual(admin.map((o) => [o.name, o.connected]), [["admin", false], ["friend", false], ["june", true]]);

  // Unlinked by name; an unknown name is refused.
  assert.equal((await app.inject({ method: "POST", url: "/admin/music/tidal/disconnect", payload: { user: "nobody" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/admin/music/tidal/disconnect", payload: { user: "JUNE" } })).statusCode, 200);
  assert.equal(await state(june), false);
});
