import fs from "node:fs";
import path from "node:path";
import { openServerDb } from "./serverdb.js";
import { Mirror } from "./mirror.js";
import { recentPageChurn, type PageChurnRow } from "./pagechurn.js";
import type { Config } from "./config.js";

// Why this module exists (2026-07-26 outage, post-mortem):
//
// The Fly volume filled to 3.0G/3.0G — 0 bytes free — and EVERY mirror-backed MCP tool started
// answering the bare string `disk I/O error`. Even `data_freshness`, whose own description says
// "Call this first", died the same way, so the one tool that should have explained the outage was
// the one that couldn't run. Meanwhile GET /healthz kept returning 200, because it only proved the
// Node process was alive and never touched /data.
//
// What actually filled the volume was not the mirror growing. It was ~2.4 GB of leaked
// `.staged-*.sqlite` files — the temp half of ingestNoopbak's atomic swap — orphaned by three
// distinct defects, the worst of which was self-amplifying: `fs.writeFileSync(staged, …)` sat
// OUTSIDE the try/catch, so once the disk got tight, every ingest attempt wrote a partial ~500 MB
// file, threw ENOSPC, and left the partial behind, consuming the very space the next attempt needed.
//
// So the invariants here are: (1) never begin a swap you don't have room to finish, (2) never leave
// a staged artifact behind on ANY exit path, and (3) make free space observable BEFORE it hits zero.

/**
 * Filenames /ingest stages under: the inflated database, the sidecars SQLite opens beside it, and
 * the `.noopbak` the request body streams into (since the body stopped being buffered in memory,
 * it is a file on this volume too, and a crash mid-upload leaks it exactly the same way).
 */
const STAGED_RE = /^\.staged-[0-9a-f]+\.(?:sqlite(?:-wal|-shm)?|noopbak)$/;

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  /** 0-100, one decimal. */
  usedPct: number;
  freePct: number;
}

/**
 * Free space on the filesystem backing `dir`, or null when the platform can't report it.
 *
 * Deliberately `bavail` (blocks available to an ordinary writer), not `bfree`: that is the number
 * `df` prints as "Avail", it excludes ext4's root-reserved blocks, and being pessimistic is the
 * correct bias for a guard whose whole job is refusing writes that might not fit.
 */
export function diskUsage(dir: string): DiskUsage | null {
  try {
    const st = fs.statfsSync(dir);
    const totalBytes = Number(st.blocks) * Number(st.bsize);
    const freeBytes = Number(st.bavail) * Number(st.bsize);
    const usedBytes = totalBytes - freeBytes;
    const pct = (n: number) => (totalBytes > 0 ? Math.round((n / totalBytes) * 1000) / 10 : 0);
    return { totalBytes, freeBytes, usedBytes, usedPct: pct(usedBytes), freePct: pct(freeBytes) };
  } catch {
    return null; // statfs unsupported or dir missing — callers treat null as "unknown", never as "full"
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "unknown";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = Math.abs(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export interface StagedArtifact { name: string; bytes: number; mtimeMs: number; }

/** Every `.staged-*` artifact currently on the volume, main files and sidecars alike. */
export function listStagedArtifacts(dataDir: string): StagedArtifact[] {
  let names: string[];
  try { names = fs.readdirSync(dataDir); } catch { return []; }
  const out: StagedArtifact[] = [];
  for (const name of names) {
    if (!STAGED_RE.test(name)) continue;
    try {
      const st = fs.statSync(path.join(dataDir, name));
      out.push({ name, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch { /* raced with a sweep — fine, it's gone */ }
  }
  return out;
}

/**
 * Delete `.staged-*` artifacts older than `olderThanMs` (default 1h).
 *
 * The age guard is the whole safety argument: an ingest in flight right now owns a staged file whose
 * mtime is seconds old, and sweeping it would corrupt a legitimate upload. Anything older than the
 * guard cannot belong to a live request — ingestNoopbak is synchronous and a ~500 MB write finishes
 * in seconds — so it is by definition a corpse from a crashed or killed process.
 */
export function sweepStagedArtifacts(dataDir: string, opts: { olderThanMs?: number; now?: number } = {}): { removed: number; bytes: number; names: string[] } {
  const olderThanMs = opts.olderThanMs ?? 3_600_000;
  const now = opts.now ?? Date.now();
  let removed = 0, bytes = 0; const names: string[] = [];
  for (const a of listStagedArtifacts(dataDir)) {
    if (now - a.mtimeMs < olderThanMs) continue;
    try {
      fs.rmSync(path.join(dataDir, a.name), { force: true });
      removed++; bytes += a.bytes; names.push(a.name);
    } catch { /* best-effort: a sweep that can't delete must never fail the request it runs inside */ }
  }
  return { removed, bytes, names };
}

/** Remove a staged main file and the -wal/-shm SQLite opened beside it. Never throws. */
export function removeStagedSet(stagedPath: string, opts: { includeMain?: boolean } = {}): void {
  const targets = [`${stagedPath}-wal`, `${stagedPath}-shm`];
  if (opts.includeMain !== false) targets.unshift(stagedPath);
  for (const t of targets) {
    try { fs.rmSync(t, { force: true }); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Storage error classification
// ---------------------------------------------------------------------------

// Two categories, because they warrant OPPOSITE responses.
//
// VOLUME errors mean the filesystem is the problem — no space, bad I/O, read-only mount. Nothing the
// caller sent could have avoided them and re-sending won't help.
//
// PAYLOAD errors describe the bytes of one particular database file. On a READ of the mirror that is
// still a server-side fault (the client cannot fix a corrupt mirror), but on an INGEST it means the
// UPLOAD was bad — and answering "server storage degraded, retry later" to a corrupt upload would
// have the phone retry the same broken bytes forever. Hence isVolumeError for the write path.
//
// better-sqlite3 surfaces primary AND extended result codes (SQLITE_IOERR, SQLITE_IOERR_SHMOPEN, …),
// so match on prefix rather than exact equality.
const VOLUME_SQLITE_PREFIXES = [
  "SQLITE_IOERR", "SQLITE_FULL", "SQLITE_CANTOPEN", "SQLITE_READONLY", "SQLITE_NOMEM", "SQLITE_PROTOCOL",
];
const PAYLOAD_SQLITE_PREFIXES = ["SQLITE_CORRUPT", "SQLITE_NOTADB"];
/** Node fs/libuv errno codes that mean the same thing one layer down. */
const FS_STORAGE_CODES = new Set(["ENOSPC", "EIO", "EROFS", "EDQUOT", "ENFILE", "EMFILE"]);
// Last-resort text match. The 2026-07-26 outage surfaced literally "disk I/O error" to MCP clients,
// and a driver that ever throws that without a .code must still be classified correctly.
const STORAGE_MESSAGE_RE = /disk i\/o error|database or disk is full|unable to open database|no space left/i;

const errCode = (e: unknown): string | null =>
  e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : null;

/** The filesystem itself is failing: out of space, I/O error, read-only. Retrying the same call won't help. */
export function isVolumeError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const code = errCode(e);
  if (code && (FS_STORAGE_CODES.has(code) || VOLUME_SQLITE_PREFIXES.some((p) => code.startsWith(p)))) return true;
  const msg = (e as { message?: unknown }).message;
  return typeof msg === "string" && STORAGE_MESSAGE_RE.test(msg);
}

/**
 * Another process holds the lock right now. Under liters page replication that process is the
 * applier and this is the system working, not failing — so it must never be classified as a volume
 * fault (which would say "retry later, the disk is broken") or a payload fault (which would say
 * "your bytes are corrupt"). It is its own thing: transient, expected, and self-clearing.
 */
export function isBusyError(e: unknown): boolean {
  const code = errCode(e);
  return !!code && (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_"));
}

/** The BYTES of one database file are bad (corrupt / not a database), independent of the volume. */
export function isPayloadDbError(e: unknown): boolean {
  const code = errCode(e);
  return !!code && !isVolumeError(e) && PAYLOAD_SQLITE_PREFIXES.some((p) => code.startsWith(p));
}

/** Any storage-layer fault, including a corrupt/unreadable database file. Use on READ paths. */
export function isStorageError(e: unknown): boolean {
  return isVolumeError(e) || isPayloadDbError(e);
}

/** Thrown/returned in place of a raw driver string once a failure is known to be storage-level. */
export class StorageDegradedError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "StorageDegradedError";
  }
}

// ---------------------------------------------------------------------------
// Storage report — the thing that should have existed before the outage
// ---------------------------------------------------------------------------

/**
 * Can the mirror actually be SERVED right now — not "does the file exist", but "does opening it the
 * way every tool opens it, and reading its schema, succeed"?
 *
 * Deliberately the real serving path (`new Mirror(...)` + a sqlite_master read, exactly what
 * `hasTable` does) rather than a stat or a header sniff. A stat cannot tell a good 766 MB mirror from
 * a corrupt one, and the header alone survives the common corruption shape — SQLite only raises
 * SQLITE_NOTADB on the first real page read.
 *
 * Cheap enough for a 30-second health check: a read-only open reads the header and one schema page,
 * not the file. No PRAGMA integrity/quick_check — those scan the whole database and would turn the
 * health check into 766 MB of I/O every interval.
 */
export function mirrorReadable(mirrorPath: string): { ok: boolean; busy?: boolean; error?: string } {
  try {
    // 1.5 s, not the 5 s default. Fly's [[http_service.checks]] gives this whole endpoint 5 s
    // (fly.toml), so a probe that waited the driver's default would time out the CHECK rather than
    // return a verdict — and a failed check pulls the machine out of routing. Under liters the
    // mirror is written in place by the sink, so waiting on a lock is now a normal thing to do here.
    const m = new Mirror(mirrorPath, { busyTimeoutMs: 1_500 });
    try { m.hasTable("dailyMetric"); } finally { m.close(); }
    return { ok: true };
  } catch (e) {
    // SQLITE_BUSY is not a degraded mirror. It means another process holds the write lock right
    // now — i.e. replication is working. Reporting it as a fault would make a healthy apply look
    // identical to a corrupt database, and would flip /healthz red every time a large delta landed.
    if (isBusyError(e)) return { ok: true, busy: true };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface StorageReport {
  ok: boolean;
  dataDir: string;
  disk: DiskUsage | null;
  /**
   * `readable` is null unless `probeMirror` was requested, and stays null when the mirror is absent
   * (nothing to read is not the same as unreadable — see the missing-mirror note below).
   */
  mirror: { exists: boolean; bytes: number | null; modifiedAt: string | null; readable: boolean | null };
  serverDb: { exists: boolean; bytes: number | null };
  stagedOrphans: { count: number; bytes: number };
  lastIngestAt: string | null;
  lastIngestAgeSeconds: number | null;
  /** Set when even the bookkeeping DB could not be read — i.e. the disk problem is total. */
  lastIngestError?: string;
  /** Can the volume absorb one more atomic swap (a second full copy of the mirror + headroom)? */
  nextIngestFits: boolean | null;
  /**
   * P0 of docs/SYNC_BUILD_VS_BUY.md — the last few page-diff measurements, newest first (see
   * src/pagechurn.ts). This is how the churn number gets read without SSH-ing to the machine.
   *
   * Present ONLY when asked for, because the same report is embedded verbatim in every
   * `data_freshness` MCP response and in /healthz's liveness check: a ~1.5 KB experiment log has no
   * business in the tool an agent is told to call first. `GET /status` asks for it; nothing else does.
   * Deliberately outside the `ok` verdict too — a telemetry fault must never turn a health check red.
   */
  pageChurn?: PageChurnRow[];
  warnings: string[];
}

type StorageCfg = Pick<Config, "dataDir" | "mirrorPath" | "serverDbPath"> & { minFreeBytes?: number };

const statOr = (p: string) => { try { return fs.statSync(p); } catch { return null; } };

/**
 * One call that answers "is storage healthy, and if not, why" — including when the volume is so full
 * that opening server.sqlite throws. Every step is individually guarded; this function must not be
 * capable of failing for the reason it exists to diagnose.
 */
export function storageReport(cfg: StorageCfg, opts: { pageChurnLimit?: number; probeMirror?: boolean } = {}): StorageReport {
  const minFree = cfg.minFreeBytes ?? 268_435_456;
  const disk = diskUsage(cfg.dataDir);
  const mStat = statOr(cfg.mirrorPath);
  const sStat = statOr(cfg.serverDbPath);
  const orphans = listStagedArtifacts(cfg.dataDir);
  const orphanBytes = orphans.reduce((a, b) => a + b.bytes, 0);

  let lastIngestAt: string | null = null;
  let lastIngestAgeSeconds: number | null = null;
  let lastIngestError: string | undefined;
  let pageChurn: PageChurnRow[] | undefined;
  try {
    const db = openServerDb(cfg);
    try {
      const r = db.prepare("SELECT receivedAt FROM ingestLog ORDER BY id DESC LIMIT 1").get() as { receivedAt: number } | undefined;
      if (r?.receivedAt) {
        lastIngestAt = new Date(r.receivedAt * 1000).toISOString();
        lastIngestAgeSeconds = Math.floor(Date.now() / 1000) - r.receivedAt;
      }
      // Its own try, INSIDE the connection: a fault reading the experiment's table must not surface as
      // `lastIngestError`, which is a warning and would flip storageReport().ok — and /healthz with it.
      if (opts.pageChurnLimit) {
        try { pageChurn = recentPageChurn(db, opts.pageChurnLimit); } catch { /* telemetry is never load-bearing */ }
      }
    } finally { db.close(); }
  } catch (e) {
    lastIngestError = e instanceof Error ? e.message : String(e);
  }

  const warnings: string[] = [];
  // The predictive check, and the single most useful line here: an ingest stages a SECOND full copy
  // of the mirror before renaming over the first, so "free space" is only meaningful relative to the
  // mirror's own size. This goes false while there is still a GB free — which is the point.
  const needed = (mStat?.size ?? 0) + minFree;
  const nextIngestFits = disk ? disk.freeBytes >= needed : null;

  // Thresholds are RELATIVE TO WHAT AN INGEST NEEDS, never a bare percentage. A percentage trigger is
  // meaningless across volume sizes — a 94.9% full laptop disk with 24 GB free is completely healthy
  // for this server, and warning about it trains the reader to ignore warnings. What matters is the
  // only question the server actually has: does the next atomic swap still fit?
  if (disk) {
    if (disk.freeBytes === 0) {
      warnings.push("volume is COMPLETELY full (0 bytes free) — SQLite cannot open the mirror");
    } else if (nextIngestFits === false) {
      warnings.push(`next /ingest will be REFUSED: needs ${formatBytes(needed)} (staged copy + headroom), only ${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}`);
    } else if (disk.freeBytes < needed * 2) {
      warnings.push(`volume is tight: ${formatBytes(disk.freeBytes)} free, one ingest needs ${formatBytes(needed)}`);
    }
  }
  if (orphans.length) warnings.push(`${orphans.length} orphaned .staged-* artifact(s) holding ${formatBytes(orphanBytes)} — swept automatically on the next ingest`);
  // A missing mirror is NOT a warning: a freshly-deployed server that has never been uploaded to is
  // new, not degraded. `mirror.exists: false` and a null lastIngestAt already state the fact.
  //
  // A mirror that EXISTS but cannot be opened is the opposite: every mirror-backed MCP tool is down.
  // Probed only on request because the caller that has to know — /healthz — is the one place nothing
  // else opens the mirror. data_freshness deliberately does not ask: it opens the mirror itself and
  // reports its own `degraded` flag, so probing here would just open a 766 MB database twice per call.
  let mirrorOk: boolean | null = null;
  if (opts.probeMirror && mStat) {
    const probe = mirrorReadable(cfg.mirrorPath);
    mirrorOk = probe.ok;
    // The gap this closes: before it, a mirror corrupted in place left disk, orphans and server.sqlite
    // all clean, so /healthz answered exactly {ok:true} while every tool returned "storage is
    // degraded". Same failure signature as the 2026-07-26 outage — a green health check through a
    // total serving outage — with a different cause.
    if (!probe.ok) warnings.push(`mirror.sqlite EXISTS but cannot be read: ${probe.error} — every mirror-backed MCP tool is failing`);
  }
  if (lastIngestError) warnings.push(`server.sqlite unreadable: ${lastIngestError}`);
  // 48h: the phone uploads on every background wake, so a day and a half of silence is already an
  // outage, not a quiet period.
  if (lastIngestAgeSeconds !== null && lastIngestAgeSeconds > 172_800) {
    warnings.push(`no successful ingest for ${(lastIngestAgeSeconds / 86_400).toFixed(1)} days — the phone's uploads are failing`);
  }

  return {
    ok: warnings.length === 0,
    dataDir: cfg.dataDir,
    disk,
    mirror: { exists: !!mStat, bytes: mStat?.size ?? null, modifiedAt: mStat ? new Date(mStat.mtimeMs).toISOString() : null, readable: mirrorOk },
    serverDb: { exists: !!sStat, bytes: sStat?.size ?? null },
    stagedOrphans: { count: orphans.length, bytes: orphanBytes },
    lastIngestAt,
    lastIngestAgeSeconds,
    ...(lastIngestError ? { lastIngestError } : {}),
    nextIngestFits,
    ...(pageChurn ? { pageChurn } : {}),
    warnings,
  };
}

/**
 * The message an MCP client sees instead of `disk I/O error`.
 *
 * Three jobs: say it is the SERVER that is broken (so the caller stops debugging their own request),
 * give the number that proves it, and name the fix. Retry advice is explicit because the failure is
 * not transient — a full disk stays full.
 */
export function storageFailureMessage(cfg: StorageCfg, e?: unknown): string {
  let report: StorageReport | null = null;
  try { report = storageReport(cfg); } catch { /* diagnostics must never mask the original failure */ }
  const parts = ["noop-cloud storage is degraded — the SQLite mirror could not be read."];
  const d = report?.disk;
  if (d) {
    parts.push(d.freeBytes === 0
      ? `The data volume is COMPLETELY FULL: 0 bytes free of ${formatBytes(d.totalBytes)}.`
      : `Data volume: ${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)} (${d.usedPct}% used).`);
  }
  if (report?.stagedOrphans.count) {
    parts.push(`${report.stagedOrphans.count} orphaned staging file(s) are holding ${formatBytes(report.stagedOrphans.bytes)}.`);
  }
  if (report?.lastIngestAt) {
    parts.push(`Last successful ingest: ${report.lastIngestAt}` +
      (report.lastIngestAgeSeconds !== null ? ` (${(report.lastIngestAgeSeconds / 86_400).toFixed(1)} days ago).` : "."));
  }
  parts.push("This is a server-side storage fault, not a bad request — the same call will keep failing until the volume has space. Check GET /status, free space on the Fly volume, or grow it.");
  const raw = e instanceof Error ? e.message : e ? String(e) : null;
  if (raw) parts.push(`Underlying error: ${raw}`);
  return parts.join(" ");
}
