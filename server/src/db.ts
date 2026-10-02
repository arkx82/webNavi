import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

/**
 * The server's own records, in one SQLite file beside the settings
 * (node:sqlite, no native module to build): the car page's users and what
 * each keeps — 집 · 회사 · 즐겨찾기, recent places, 안내 설정 — so a phone and
 * the car see the same; and an index of every sentence the voice has made,
 * so the same words are never paid for twice and /admin can say what is kept.
 */
export interface User {
  id: number;
  name: string;
  created: number;
  lastSeen: number | null;
}

/** What a user keeps, by name; the page owns each value's shape. */
export const USER_KEYS = ["places", "recents", "guide", "drive"] as const;
export type UserKey = (typeof USER_KEYS)[number];

export class Db {
  private db: DatabaseSync;

  constructor(dir: string) {
    this.db = new DatabaseSync(join(dir, "webnavi.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        hash TEXT NOT NULL,
        created INTEGER NOT NULL,
        last_seen INTEGER,
        -- Raised on a password change or a reset: the older sessions stop working.
        epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS user_data (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      CREATE TABLE IF NOT EXISTS tts (
        file TEXT PRIMARY KEY,
        voice TEXT NOT NULL,
        text TEXT NOT NULL,
        model TEXT,
        bytes INTEGER,
        created INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        uses INTEGER NOT NULL DEFAULT 1,
        -- 1 once the sentence was asked again with its full stop (tts.ts): what came is what there is.
        repaired INTEGER NOT NULL DEFAULT 0
      );
      -- A place sent from a phone (/share): to whom, by whom, kept a day.
      CREATE TABLE IF NOT EXISTS shared (
        id INTEGER PRIMARY KEY,
        to_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        from_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        lon REAL NOT NULL,
        lat REAL NOT NULL,
        sent INTEGER NOT NULL,
        dismissed INTEGER NOT NULL DEFAULT 0
      );
      PRAGMA foreign_keys = ON;
    `);
    // A file from before the column: given it.
    const columns = this.db.prepare("PRAGMA table_info(tts)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "repaired")) this.db.exec("ALTER TABLE tts ADD COLUMN repaired INTEGER NOT NULL DEFAULT 0");
  }

  // ---- places sent from a phone ----

  share(to: number, from: number, place: { name: string; address: string; at: [number, number] }) {
    this.db.prepare("INSERT INTO shared (to_user, from_user, name, address, lon, lat, sent) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(to, from, place.name, place.address, place.at[0], place.at[1], Date.now());
    // Shown for a day (share.ts KEEP_MS); a week's kept, older ones go.
    this.db.prepare("DELETE FROM shared WHERE sent < ?").run(Date.now() - 7 * 86_400_000);
  }

  /** The places sent to [userId] since [since], newest first, with who sent them. */
  inbox(userId: number, since: number): { id: number; name: string; address: string; at: [number, number]; sent: number; from: string | null }[] {
    const rows = this.db.prepare(`SELECT s.id, s.name, s.address, s.lon, s.lat, s.sent, u.name AS sender FROM shared s LEFT JOIN users u ON u.id = s.from_user
      WHERE s.to_user = ? AND s.sent >= ? AND s.dismissed = 0 ORDER BY s.sent DESC LIMIT 5`).all(userId, since) as { id: number; name: string; address: string; lon: number; lat: number; sent: number; sender: string | null }[];
    return rows.map((r) => ({ id: r.id, name: r.name, address: r.address, at: [r.lon, r.lat], sent: r.sent, from: r.sender }));
  }

  dismissShared(userId: number, id: number) {
    this.db.prepare("UPDATE shared SET dismissed = 1 WHERE id = ? AND to_user = ?").run(id, userId);
  }

  // ---- users ----

  users(): User[] {
    const rows = this.db.prepare("SELECT id, name, created, last_seen AS lastSeen FROM users ORDER BY name").all() as unknown as User[];
    return rows.map((r) => ({ id: r.id, name: r.name, created: r.created, lastSeen: r.lastSeen }));
  }

  addUser(name: string, password: string): User {
    const clean = name.trim();
    if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(clean)) throw new Error("아이디는 2~32자, 글자·숫자·._- 만");
    if (password.length < 6) throw new Error("비밀번호는 6자 이상");
    try {
      this.db.prepare("INSERT INTO users (name, hash, created) VALUES (?, ?, ?)").run(clean, hashOf(password), Date.now());
    } catch (e) {
      if (/UNIQUE/.test((e as Error).message)) throw new Error("이미 있는 아이디입니다");
      throw e;
    }
    return this.users().find((u) => u.name.toLowerCase() === clean.toLowerCase())!;
  }

  setPassword(id: number, password: string) {
    if (password.length < 6) throw new Error("비밀번호는 6자 이상");
    this.db.prepare("UPDATE users SET hash = ?, epoch = epoch + 1 WHERE id = ?").run(hashOf(password), id);
  }

  removeUser(id: number) {
    this.db.prepare("DELETE FROM user_data WHERE user_id = ?").run(id);
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }

  /** The user if the password is theirs; the same time taken for a name that is not there. */
  check(name: string, password: string): (User & { epoch: number }) | null {
    const row = this.db.prepare("SELECT id, name, hash, created, last_seen AS lastSeen, epoch FROM users WHERE name = ?").get(name.trim()) as
      | { id: number; name: string; hash: string; created: number; lastSeen: number | null; epoch: number }
      | undefined;
    const ok = verifyHash(password, row?.hash ?? DUMMY);
    if (!row || !ok) return null;
    return { id: row.id, name: row.name, created: row.created, lastSeen: row.lastSeen, epoch: row.epoch };
  }

  /** The user a session names, if it is still theirs (not removed, password not changed since). */
  session(id: number, epoch: number): User | null {
    const row = this.db.prepare("SELECT id, name, created, last_seen AS lastSeen, epoch FROM users WHERE id = ?").get(id) as
      | (User & { epoch: number })
      | undefined;
    if (!row || row.epoch !== epoch) return null;
    return { id: row.id, name: row.name, created: row.created, lastSeen: row.lastSeen };
  }

  seen(id: number) {
    this.db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(Date.now(), id);
  }

  // ---- what each user keeps ----

  data(userId: number): Partial<Record<UserKey, { value: unknown; updated: number }>> {
    const rows = this.db.prepare("SELECT key, value, updated FROM user_data WHERE user_id = ?").all(userId) as { key: UserKey; value: string; updated: number }[];
    const out: Partial<Record<UserKey, { value: unknown; updated: number }>> = {};
    for (const r of rows) {
      try { out[r.key] = { value: JSON.parse(r.value), updated: r.updated }; } catch { /* a bad row is skipped */ }
    }
    return out;
  }

  setData(userId: number, key: UserKey, value: unknown): number {
    const updated = Date.now();
    this.db.prepare("INSERT INTO user_data (user_id, key, value, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated = excluded.updated")
      .run(userId, key, JSON.stringify(value), updated);
    return updated;
  }

  // ---- the voice's sentences ----

  /** A sentence made (or found on disk the first time since the index began). */
  ttsMade(file: string, voice: string, text: string, model: string | null, bytes: number) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO tts (file, voice, text, model, bytes, created, last_used, uses) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (file) DO UPDATE SET last_used = excluded.last_used, uses = uses + 1`).run(file, voice, text, model, bytes, now, now);
  }

  /** A sentence served from what was kept. */
  ttsUsed(file: string) {
    this.db.prepare("UPDATE tts SET last_used = ?, uses = uses + 1 WHERE file = ?").run(Date.now(), file);
  }

  /** A kept sentence's words and voice, where the index has them, and whether it was already made again once. */
  ttsRow(file: string): { text: string; voice: string; repaired: boolean } | null {
    const r = this.db.prepare("SELECT text, voice, repaired FROM tts WHERE file = ?").get(file) as { text: string; voice: string; repaired: number } | undefined;
    return r ? { text: r.text, voice: r.voice, repaired: r.repaired === 1 } : null;
  }

  /** The sentence was asked again with its full stop: not to be taken out for being cut off again. */
  ttsRepaired(file: string) {
    this.db.prepare("UPDATE tts SET repaired = 1 WHERE file = ?").run(file);
  }

  /** Whether [text] was served, in any voice, since [ms]: a name said on last week's drive is still wanted. */
  ttsUsedSince(text: string, ms: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM tts WHERE text = ? AND last_used >= ?").get(text, ms);
  }

  ttsForget(file: string) {
    this.db.prepare("DELETE FROM tts WHERE file = ?").run(file);
  }

  ttsKnown(file: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM tts WHERE file = ?").get(file);
  }

  ttsStats(): { sentences: number; voices: number; bytes: number; uses: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS sentences, COUNT(DISTINCT voice) AS voices, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(uses), 0) AS uses FROM tts").get() as {
      sentences: number; voices: number; bytes: number; uses: number;
    };
    return { sentences: Number(r.sentences), voices: Number(r.voices), bytes: Number(r.bytes), uses: Number(r.uses) };
  }
}

function hashOf(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`;
}

function verifyHash(password: string, kept: string): boolean {
  const [salt, hash] = kept.split(":");
  const tried = scryptSync(password, Buffer.from(salt, "hex"), 32);
  return timingSafeEqual(tried, Buffer.from(hash, "hex"));
}

/** Checked against when the name is unknown, so a wrong name takes as long as a wrong password. */
const DUMMY = hashOf(randomBytes(12).toString("hex"));
