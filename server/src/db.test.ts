import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db } from "./db.js";

const fresh = () => new Db(mkdtempSync(join(tmpdir(), "webnavi-db-")));

test("a user logs in with their password only; a name is one name whatever its case", () => {
  const db = fresh();
  db.addUser("june", "secret1");
  assert.equal(db.check("june", "secret1")?.name, "june");
  assert.equal(db.check("june", "wrong!!"), null);
  assert.equal(db.check("nobody", "secret1"), null);
  assert.throws(() => db.addUser("JUNE", "another"), /이미/);
  assert.throws(() => db.addUser("x", "secret1"), /2~32/);
});

test("a password changed ends the sessions made before it", () => {
  const db = fresh();
  const u = db.addUser("june", "secret1");
  const s = db.check("june", "secret1")!;
  assert.equal(db.session(u.id, s.epoch)?.name, "june");
  db.setPassword(u.id, "secret2");
  assert.equal(db.session(u.id, s.epoch), null);
  assert.equal(db.session(u.id, db.check("june", "secret2")!.epoch)?.name, "june");
});

test("each user keeps their own places; a removed user's go with them", () => {
  const db = fresh();
  const a = db.addUser("june", "secret1");
  const b = db.addUser("mina", "secret1");
  db.setData(a.id, "places", { home: { name: "집" } });
  db.setData(a.id, "places", { home: { name: "새 집" } });
  assert.deepEqual(db.data(a.id).places?.value, { home: { name: "새 집" } });
  assert.equal(db.data(b.id).places, undefined);
  db.removeUser(a.id);
  assert.deepEqual(db.data(a.id), {});
});

test("the voice's index counts a sentence once and every reuse after", () => {
  const db = fresh();
  db.ttsMade("a.wav", "Cherry", "안내를 시작합니다", "qwen3-tts-flash", 1000);
  db.ttsUsed("a.wav");
  db.ttsUsed("a.wav");
  assert.ok(db.ttsKnown("a.wav"));
  assert.deepEqual(db.ttsStats(), { sentences: 1, voices: 1, bytes: 1000, uses: 3 });
});

test("a sentence made again with its full stop is marked so, and an index from before the mark takes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "webnavi-db-"));
  const old = new DatabaseSync(join(dir, "webnavi.db"));
  old.exec("CREATE TABLE tts (file TEXT PRIMARY KEY, voice TEXT NOT NULL, text TEXT NOT NULL, model TEXT, bytes INTEGER, created INTEGER NOT NULL, last_used INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 1)");
  old.prepare("INSERT INTO tts (file, voice, text, model, bytes, created, last_used) VALUES ('a.wav', 'Cherry', '제한 속도 50', 'qwen3-tts-flash', 1000, 1, 1)").run();
  old.close();
  const db = new Db(dir);
  assert.deepEqual(db.ttsRow("a.wav"), { text: "제한 속도 50", voice: "Cherry", repaired: false });
  db.ttsRepaired("a.wav");
  assert.equal(db.ttsRow("a.wav")?.repaired, true);
  db.ttsMade("b.wav", "Cherry", "안내를 시작합니다", "qwen3-tts-flash", 1000);
  assert.equal(db.ttsRow("b.wav")?.repaired, false);
  db.ttsForget("a.wav");
  db.ttsMade("a.wav", "Cherry", "제한 속도 50", "qwen3-tts-flash", 1000);
  assert.equal(db.ttsRow("a.wav")?.repaired, false, "made afresh, it is unmarked again");
  assert.doesNotThrow(() => new Db(dir), "opened once more, the column is there already");
});
