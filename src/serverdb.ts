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
    -- The deep-buffer archive's INDEX (#423). The payload itself lives in object storage (see
    -- src/objectstore.ts — ~9 GB/month would destroy the ~547 MB Fly volume); this table is what makes
    -- it queryable without fetching any of it back. One row per ~16 MB chunk is ~1100 rows/month, i.e.
    -- kilobytes — the asymmetry that makes the split work.
    --
    -- UNIQUE(generation, byteStart) is load-bearing, not hygiene: it is exactly the phone's watermark
    -- unit, so it makes a retried at-least-once upload a no-op instead of a duplicate row.
    CREATE TABLE IF NOT EXISTS deepBufferChunk (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generation TEXT NOT NULL, byteStart INTEGER NOT NULL, byteEnd INTEGER NOT NULL,
      objectKey TEXT NOT NULL, deviceId TEXT,
      storedBytes INTEGER NOT NULL, rawBytes INTEGER NOT NULL, lines INTEGER NOT NULL,
      firstTsMs INTEGER, lastTsMs INTEGER, firstStrapTs INTEGER, lastStrapTs INTEGER,
      n1244 INTEGER NOT NULL DEFAULT 0, n2140 INTEGER NOT NULL DEFAULT 0,
      nOther INTEGER NOT NULL DEFAULT 0, nImu INTEGER NOT NULL DEFAULT 0,
      nOffload INTEGER NOT NULL DEFAULT 0, badLines INTEGER NOT NULL DEFAULT 0,
      receivedAt INTEGER NOT NULL, phoneTz TEXT,
      UNIQUE (generation, byteStart));
    -- Coverage/window queries range over strap_ts (the second the STRAP stamped), never over receivedAt.
    CREATE INDEX IF NOT EXISTS deepBufferChunk_strap ON deepBufferChunk (firstStrapTs, lastStrapTs);
    -- P0 of docs/SYNC_BUILD_VS_BUY.md: how many SQLite pages actually differ between the outgoing
    -- mirror and each incoming snapshot (see src/pagechurn.ts). One row per ingest, ~120 bytes.
    --
    -- This is a falsification experiment, so it needs a SERIES, not a reading: the document's entire
    -- case for page-level replication is the unmeasured claim that a routine sync dirties 1-3% of the
    -- file, and one sync cannot distinguish "1% every time" from "1% now, 40% after a recompute".
    -- Kept unbounded on purpose — at VK's cadence a year of syncs is well under a megabyte.
    CREATE TABLE IF NOT EXISTS ingestPageChurn (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      measuredAt INTEGER NOT NULL,
      pageSize INTEGER NOT NULL, oldPageSize INTEGER,
      oldPageCount INTEGER NOT NULL, newPageCount INTEGER NOT NULL,
      pagesDiffering INTEGER NOT NULL, pagesAdded INTEGER NOT NULL, pagesRemoved INTEGER NOT NULL,
      firstChangedPage INTEGER, lastChangedPage INTEGER,
      deltaPages INTEGER NOT NULL, deltaBytes INTEGER NOT NULL, churnPct REAL NOT NULL,
      -- The compressed body /ingest actually received, beside deltaBytes: the win is this ratio.
      uploadBytes INTEGER NOT NULL,
      compareMs INTEGER NOT NULL, bytesRead INTEGER NOT NULL,
      pageSizeChanged INTEGER NOT NULL DEFAULT 0, bootstrap INTEGER NOT NULL DEFAULT 0);
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
