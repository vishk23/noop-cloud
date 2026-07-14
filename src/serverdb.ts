import Database from "better-sqlite3";
import type { Config } from "./config.js";

/** Single opener for the server-owned DB (never the mirror). All CREATEs are idempotent. */
export function openServerDb(cfg: Pick<Config, "serverDbPath">): Database.Database {
  const db = new Database(cfg.serverDbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingestLog (id INTEGER PRIMARY KEY AUTOINCREMENT, receivedAt INTEGER, bytes INTEGER, latestDay TEXT);
    CREATE TABLE IF NOT EXISTS proposal (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payloadJSON TEXT NOT NULL, rationale TEXT NOT NULL,
      beforeJSON TEXT, diffText TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
      createdAt INTEGER NOT NULL, resolvedAt INTEGER);
    CREATE TABLE IF NOT EXISTS editJournal (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, editId TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      payloadJSON TEXT NOT NULL, beforeJSON TEXT, rationale TEXT,
      appliedAt INTEGER NOT NULL, undoneBySeq INTEGER, ackedAt INTEGER);
    CREATE TABLE IF NOT EXISTS deviceToken (
      token TEXT PRIMARY KEY, platform TEXT NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pushState (id INTEGER PRIMARY KEY CHECK (id = 1), lastPushAt INTEGER);
  `);
  const cols = db.prepare("PRAGMA table_info(editJournal)").all() as any[];
  if (!cols.some((c) => c.name === "ackedAt")) db.exec("ALTER TABLE editJournal ADD COLUMN ackedAt INTEGER");
  // The phone's IANA timezone (X-Phone-Timezone header on /ingest), NULL when absent or malformed.
  // Every timestamp in an upload is epoch-UTC, so this is the only record of which zone the phone was
  // in as of a given upload. Guarded ADD COLUMN (same idiom as ackedAt) so existing DBs migrate in place.
  const ingestCols = db.prepare("PRAGMA table_info(ingestLog)").all() as any[];
  if (!ingestCols.some((c) => c.name === "phoneTz")) db.exec("ALTER TABLE ingestLog ADD COLUMN phoneTz TEXT");
  return db;
}
