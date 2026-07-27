import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import Database from "better-sqlite3";
import type { Config } from "./config.js";
import { openServerDb } from "./serverdb.js";
import { diskUsage, formatBytes, sweepStagedArtifacts, removeStagedSet, isVolumeError, isPayloadDbError, storageFailureMessage } from "./storage.js";
import { readCentralDirectory, extractEntryToFile, ZipError } from "./zipstream.js";

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

/** Client hung up mid-upload. Not an error to answer — there is no socket left to answer on. */
export class UploadAbortedError extends Error {
  constructor(public bytesReceived: number) { super(`upload aborted after ${bytesReceived} bytes`); }
}

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

const minFreeOf = (cfg: IngestCfg) => cfg.minFreeBytes ?? 268_435_456;

/** `.staged-<hex>.<ext>` — the one filename shape sweepStagedArtifacts knows how to reclaim. */
export function stagedPath(dataDir: string, ext: "sqlite" | "noopbak"): string {
  return path.join(dataDir, `.staged-${crypto.randomBytes(6).toString("hex")}.${ext}`);
}

/**
 * Refuse an upload the volume cannot hold, BEFORE a byte of it is written.
 *
 * `bytes` is what is about to be created: the compressed body on the way in, then the staged copy of
 * the database. Both are measured against free space at the moment they are about to be written, so
 * the second check already accounts for the first one's file.
 */
export function requireSpaceFor(bytes: number, cfg: IngestCfg, what: string): void {
  const minFree = minFreeOf(cfg);
  const du = diskUsage(cfg.dataDir);
  if (!du) return; // platform cannot report free space — never treat "unknown" as "full"
  const needed = bytes + minFree;
  if (du.freeBytes < needed) {
    throw new IngestError("insufficient_space",
      `need ${formatBytes(needed)} (${formatBytes(bytes)} ${what} + ${formatBytes(minFree)} headroom), ` +
      `only ${formatBytes(du.freeBytes)} free of ${formatBytes(du.totalBytes)} (${du.usedPct}% used)`,
      507);
  }
}

/**
 * Stream a request body to a file on the data volume, enforcing the size ceiling as it arrives.
 *
 * This replaces `express.raw({ limit })`, which buffered the entire ~200 MB body in memory as the
 * first of three full copies of the upload. Nothing here is proportional to the body: chunks go
 * straight to disk with backpressure.
 *
 * On overflow the request is NOT destroyed — destroying an IncomingMessage tears down the socket,
 * and the 413 would never reach the phone (it would see exactly the `connection closed before
 * message completed` that the OOM produced). It is paused instead, so the response can be written.
 */
export function receiveUploadBody(req: IncomingMessage, destPath: string, cfg: IngestCfg): Promise<number> {
  const max = cfg.maxIngestBytes;
  return new Promise<number>((resolve, reject) => {
    const sink = fs.createWriteStream(destPath, { highWaterMark: 64 * 1024 });
    let bytes = 0, settled = false, ended = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > max) {
        req.pause();
        sink.end(() => settle(() => reject(new IngestError("too_large", `body exceeds ${max} bytes`, 413))));
        return;
      }
      if (!sink.write(chunk)) { req.pause(); sink.once("drain", () => req.resume()); }
    });
    req.on("end", () => { ended = true; sink.end(() => settle(() => resolve(bytes))); });
    // 'close' fires on a clean end too, so it only means "aborted" when 'end' never came.
    req.on("close", () => { if (!ended) { sink.destroy(); settle(() => reject(new UploadAbortedError(bytes))); } });
    // An error on the REQUEST stream is the connection failing (`aborted`, ECONNRESET), never
    // something the upload did wrong — there is no socket left to answer on, so it is the same
    // quiet outcome as a close, not a 500 logged as if the server had broken.
    req.on("error", () => { sink.destroy(); settle(() => reject(new UploadAbortedError(bytes))); });
    sink.on("error", (e) => { req.pause(); settle(() => reject(e)); }); // ENOSPC lands here
  });
}

export interface IngestResult { ok: true; bytes: number; latestDay: string | null }

/**
 * Ingest a `.noopbak` that is already on disk. This is the real implementation; the Buffer overload
 * below exists for callers that already hold the bytes.
 *
 * Memory is flat: the zip's central directory (a few hundred bytes) plus 64 KB stream buffers. The
 * ~600 MB database is never resident. Peak DISK is body + staged copy + the live mirror, which is
 * what the two preflights bound.
 *
 * `consume: true` deletes `uploadPath` as soon as the entry has been inflated — before validation,
 * which is the point where the compressed copy stops being needed and its space can go back to the
 * volume. Callers that own the file (the /ingest handler, the Buffer overload) pass it; callers
 * passing a fixture path do not.
 */
export async function ingestNoopbakFile(
  uploadPath: string, cfg: IngestCfg, phoneTz: string | null = null, opts: { consume?: boolean } = {},
): Promise<IngestResult> {
  const uploadBytes = fs.statSync(uploadPath).size;
  if (uploadBytes > cfg.maxIngestBytes) throw new IngestError("too_large", `body ${uploadBytes} > ${cfg.maxIngestBytes}`, 413);

  fs.mkdirSync(cfg.dataDir, { recursive: true });

  // Reclaim crash corpses BEFORE measuring free space, so space this process already leaked counts
  // toward the preflight instead of permanently shrinking the volume. Best-effort by construction:
  // sweepStagedArtifacts swallows its own errors, because a failed cleanup must never fail an upload.
  sweepStagedArtifacts(cfg.dataDir, { olderThanMs: cfg.stagedSweepAgeMs });

  const fd = fs.openSync(uploadPath, "r");
  // Closed exactly once. fd NUMBERS get recycled the moment they are freed, so a second closeSync
  // after better-sqlite3 has opened the staged database could close ITS file instead of ours.
  let fdOpen = true;
  const closeFd = () => { if (fdOpen) { fdOpen = false; try { fs.closeSync(fd); } catch { /* already gone */ } } };
  let entry;
  try {
    const entries = readCentralDirectory(fd, uploadBytes);
    entry = entries.find((e) => e.name.endsWith(".sqlite"));
    if (!entry) throw new IngestError("no_sqlite_entry");
    // Fail on the declared size first — it is free, and a legitimate oversized backup should never
    // pay for a 600 MB inflate to find out. The REAL size is bounded again during the inflate,
    // because this field comes from the central directory and can be forged (including to 0).
    if (entry.uncompressedSize > cfg.maxIngestBytes) {
      throw new IngestError("too_large", `decompressed entry ${entry.uncompressedSize} > ${cfg.maxIngestBytes}`, 413);
    }

    // PREFLIGHT. The swap needs room for a SECOND full copy of the DB alongside the current mirror,
    // and refusing up-front is the only safe failure: a write that runs out of space midway leaves a
    // partial multi-hundred-MB file behind, which is precisely the self-amplifying leak that took the
    // volume to 0 bytes on 2026-07-26. Skipped only when the platform can't report free space at all.
    requireSpaceFor(entry.uncompressedSize, cfg, "staged copy");
  } catch (e) {
    closeFd();
    if (opts.consume) fs.rmSync(uploadPath, { force: true });
    throw e instanceof ZipError ? zipToIngestError(e) : e;
  }

  const staged = stagedPath(cfg.dataDir, "sqlite");
  let latestDay: string | null = null;
  try {
    const written = await extractEntryToFile(uploadPath, fd, uploadBytes, entry, staged,
      { maxBytes: cfg.maxIngestBytes, expectMagic: SQLITE_MAGIC });
    if (written === 0) throw new IngestError("too_large", "decompressed entry 0 bytes");
    // The compressed copy has done its job. Releasing it here, rather than in the finally, means the
    // volume only ever holds body + staged + mirror during the inflate, not through validation too.
    closeFd();
    if (opts.consume) fs.rmSync(uploadPath, { force: true });

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
    if (e instanceof ZipError) throw zipToIngestError(e);
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
    closeFd();
    if (opts.consume) fs.rmSync(uploadPath, { force: true });
    // The rename moves ONLY the main file, so the -wal/-shm that `new Database(staged)` created beside
    // it survive into the next boot unless they are cleaned up explicitly. 34 of these had accumulated
    // by the time of the outage. Runs on the success path too — that is the entire point.
    removeStagedSet(staged, { includeMain: false });
  }
  const db = openServerDb(cfg);
  db.prepare("INSERT INTO ingestLog (receivedAt, bytes, latestDay, phoneTz) VALUES (?,?,?,?)").run(Math.floor(Date.now() / 1000), uploadBytes, latestDay, phoneTz);
  db.close();
  return { ok: true, bytes: uploadBytes, latestDay };
}

/** ZIP-layer verdicts, mapped to the wire contract the phone already understands. */
function zipToIngestError(e: ZipError): IngestError {
  switch (e.code) {
    case "too_large": return new IngestError("too_large", e.message, 413);
    case "bad_magic": return new IngestError("bad_magic");
    case "encrypted": return new IngestError("bad_zip", e.message);
    case "unsupported_compression": return new IngestError("bad_zip", e.message);
    default: return new IngestError("bad_zip", e.message);
  }
}

/**
 * Buffer overload, for callers that already hold the whole `.noopbak` (tests, scripts).
 *
 * It spills to a staged file and runs the identical path, so there is exactly ONE ingest
 * implementation to reason about. `/ingest` itself never takes this route — the request body goes
 * to disk as it arrives and never becomes a Buffer at all.
 */
export async function ingestNoopbak(buf: Buffer, cfg: IngestCfg, phoneTz: string | null = null): Promise<IngestResult> {
  if (buf.length > cfg.maxIngestBytes) throw new IngestError("too_large", `body ${buf.length} > ${cfg.maxIngestBytes}`, 413);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  requireSpaceFor(buf.length, cfg, "upload");
  const upload = stagedPath(cfg.dataDir, "noopbak");
  try {
    fs.writeFileSync(upload, buf);
  } catch (e) {
    fs.rmSync(upload, { force: true });
    if (isVolumeError(e)) throw new IngestError("storage_unavailable", storageFailureMessage(cfg, e), 507);
    throw e;
  }
  return ingestNoopbakFile(upload, cfg, phoneTz, { consume: true });
}
