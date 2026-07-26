import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import Database from "better-sqlite3"; import AdmZip from "adm-zip";
import type { Config } from "./config.js";
import { openServerDb } from "./serverdb.js";
import { diskUsage, formatBytes, sweepStagedArtifacts, removeStagedSet, isVolumeError, isPayloadDbError, storageFailureMessage } from "./storage.js";

export { openServerDb } from "./serverdb.js";
/**
 * `status` exists because not every ingest failure is the client's fault. `bad_zip` is a 400;
 * `insufficient_space` is a 507 (Insufficient Storage) — the upload was perfectly valid and the
 * phone should retry it later, which is the opposite of what a 400 tells it to do.
 */
export class IngestError extends Error {
  constructor(public code: string, msg?: string, public status = 400) { super(msg ?? code); }
}
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");

export function latestIngest(cfg: Pick<Config, "serverDbPath">) {
  const db = openServerDb(cfg);
  const r = db.prepare("SELECT receivedAt, bytes, latestDay, phoneTz FROM ingestLog ORDER BY id DESC LIMIT 1").get() as any;
  db.close();
  return r ?? null;
}

// IANA timezone identifier: "Area/Location" (e.g. America/Los_Angeles, America/Argentina/Buenos_Aires),
// or the bare "UTC". Anything else (empty, injection, a raw offset) is rejected and stored as NULL.
const IANA_TZ_RE = /^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$|^UTC$/;

/** Returns the identifier if it looks like a valid IANA tz id, else null. */
export function normalizePhoneTz(raw: unknown): string | null {
  return typeof raw === "string" && IANA_TZ_RE.test(raw) ? raw : null;
}

type IngestCfg = Pick<Config, "dataDir" | "mirrorPath" | "serverDbPath" | "maxIngestBytes">
  & Partial<Pick<Config, "minFreeBytes" | "stagedSweepAgeMs">>;

export function ingestNoopbak(buf: Buffer, cfg: IngestCfg, phoneTz: string | null = null): { ok: true; bytes: number; latestDay: string | null } {
  if (buf.length > cfg.maxIngestBytes) throw new IngestError("too_large", `body ${buf.length} > ${cfg.maxIngestBytes}`);
  let zip: AdmZip;
  try { zip = new AdmZip(buf); } catch { throw new IngestError("bad_zip"); }
  const entry = zip.getEntries().find((e) => e.entryName.endsWith(".sqlite"));
  if (!entry) throw new IngestError("no_sqlite_entry");
  if (entry.header.size > cfg.maxIngestBytes) throw new IngestError("too_large", `decompressed entry ${entry.header.size} > ${cfg.maxIngestBytes}`);
  const sqliteBytes = entry.getData();
  // entry.header.size comes from the (attacker-controlled) central directory header and can be
  // forged — including forged to 0 — which would skip the earlier header-size check entirely and
  // bypass adm-zip's own maxOutputLength bounding. Re-check the ACTUAL decompressed size here.
  if (sqliteBytes.length === 0 || sqliteBytes.length > cfg.maxIngestBytes) {
    throw new IngestError("too_large", `decompressed entry ${sqliteBytes.length} bytes`);
  }
  if (!sqliteBytes.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) throw new IngestError("bad_magic");

  // Stage to a temp file, validate, then atomically rename into place.
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  // Reclaim crash corpses BEFORE measuring free space, so space this process already leaked counts
  // toward the preflight instead of permanently shrinking the volume. Best-effort by construction:
  // sweepStagedArtifacts swallows its own errors, because a failed cleanup must never fail an upload.
  sweepStagedArtifacts(cfg.dataDir, { olderThanMs: cfg.stagedSweepAgeMs });

  // PREFLIGHT. The swap needs room for a SECOND full copy of the DB alongside the current mirror,
  // and refusing up-front is the only safe failure: a write that runs out of space midway leaves a
  // partial multi-hundred-MB file behind, which is precisely the self-amplifying leak that took the
  // volume to 0 bytes on 2026-07-26. Skipped only when the platform can't report free space at all.
  const minFree = cfg.minFreeBytes ?? 268_435_456;
  const du = diskUsage(cfg.dataDir);
  if (du) {
    const needed = sqliteBytes.length + minFree;
    if (du.freeBytes < needed) {
      throw new IngestError("insufficient_space",
        `need ${formatBytes(needed)} (${formatBytes(sqliteBytes.length)} staged copy + ${formatBytes(minFree)} headroom), ` +
        `only ${formatBytes(du.freeBytes)} free of ${formatBytes(du.totalBytes)} (${du.usedPct}% used)`,
        507);
    }
  }

  const staged = path.join(cfg.dataDir, `.staged-${crypto.randomBytes(6).toString("hex")}.sqlite`);
  let latestDay: string | null = null;
  try {
    // INSIDE the try. It used to sit outside, so an ENOSPC here threw straight past the cleanup and
    // orphaned the partial file forever — each failure making the next one likelier.
    fs.writeFileSync(staged, sqliteBytes);
    const sdb = new Database(staged, { readonly: true });
    try {
      const qc = sdb.pragma("quick_check", { simple: true });
      if (qc !== "ok") throw new IngestError("quick_check_failed", String(qc));
      const hasGrdb = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='grdb_migrations'").get();
      if (!hasGrdb) throw new IngestError("foreign_db");
      latestDay = (sdb.prepare("SELECT MAX(day) d FROM dailyMetric").get() as any)?.d ?? null;
    } finally { sdb.close(); }
    // Atomic swap: rename staged -> mirror (same filesystem). Remove stale WAL/SHM sidecars.
    for (const ext of ["-wal", "-shm"]) { const s = cfg.mirrorPath + ext; if (fs.existsSync(s)) fs.rmSync(s); }
    fs.renameSync(staged, cfg.mirrorPath);
  } catch (e) {
    removeStagedSet(staged);
    // A VOLUME failure that got past the preflight (a racing writer, a shrinking volume) is a 507,
    // not a 400 — the upload was valid and retrying later is the right behaviour. Deliberately
    // isVolumeError and not isStorageError: a CORRUPT upload must keep its 400, or the phone would
    // read "retry later" and re-send the same broken bytes forever.
    if (isVolumeError(e)) throw new IngestError("storage_unavailable", storageFailureMessage(cfg, e), 507);
    // A payload that carries the SQLite magic but is corrupt past the header reaches this as a raw
    // SqliteError, which used to escape as a generic 500 "ingest_failed" — telling the phone the
    // SERVER broke and to retry the same bad bytes. It is a bad upload: 400, like every other
    // malformed-body rejection above.
    if (isPayloadDbError(e)) throw new IngestError("corrupt_sqlite", `uploaded database is unreadable: ${e instanceof Error ? e.message : String(e)}`, 400);
    throw e;
  } finally {
    // The rename moves ONLY the main file, so the -wal/-shm that `new Database(staged)` created beside
    // it survive into the next boot unless they are cleaned up explicitly. 34 of these had accumulated
    // by the time of the outage. Runs on the success path too — that is the entire point.
    removeStagedSet(staged, { includeMain: false });
  }
  const db = openServerDb(cfg);
  db.prepare("INSERT INTO ingestLog (receivedAt, bytes, latestDay, phoneTz) VALUES (?,?,?,?)").run(Math.floor(Date.now() / 1000), buf.length, latestDay, phoneTz);
  db.close();
  return { ok: true, bytes: buf.length, latestDay };
}
