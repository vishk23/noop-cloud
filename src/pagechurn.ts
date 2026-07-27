import fs from "node:fs";
import type Database from "better-sqlite3";

// P0 of docs/SYNC_BUILD_VS_BUY.md — the falsification experiment, not a feature.
//
// That document recommends replacing the whole-database upload with page-level replication: ship only
// the SQLite pages that changed. The entire recommendation rests on ONE unmeasured inference — that a
// routine sync dirties ~1-3% of the file (§2.4), i.e. 0.4-6 MB against today's 153 MB. §4 states the
// counter-case plainly: if real churn is 20-40% (freelist reuse, `dailyMetric` recomputes rewriting
// all 19 non-key columns, index page splits rippling through interior nodes) then a page diff is
// 30-60 MB/sync and LOSES to the row-level design it was supposed to replace.
//
// This module measures it. Above ~10% churn the page-replication plan is falsified and P3-P5 should
// not be built. Nothing here is tuned toward a favourable answer: the comparison is exact (byte-wise,
// never sampled, no hash collisions to explain away) and every number it records is raw.
//
// TWO CONSTRAINTS GOVERN EVERY LINE BELOW, both learned the expensive way:
//
//  1. It must not be able to fail an ingest. This runs on a server that spent ten days down. The only
//     entry point the ingest path uses is `measurePageChurn`, which cannot throw — a measurement that
//     costs an upload is worth strictly less than no measurement at all.
//  2. It must not allocate proportionally to the file. The 2026-07-26 OOM was 1993 MB peak RSS from
//     buffering a 600 MB upload. Both files are walked through two reused ~1 MiB buffers opened with
//     positional `readSync`; peak RSS contribution is ~2 MiB regardless of a 766 MB mirror.
//
// The seam for P3/P4 is the per-page comparison inside `comparePageFiles`. P0 compares bytes because
// it transiently holds BOTH files and exactness is free; the phone will not, so P3's manifest hashes
// each page to 8 bytes at exactly this loop. The file walking, header parsing and page arithmetic —
// which is where the fiddly correctness lives — are shared and stay.

/** Anything that makes a measurement impossible. Never escapes `measurePageChurn`. */
export class PageChurnError extends Error {}

const SQLITE_HEADER_BYTES = 100;
const SQLITE_MAGIC = "SQLite format 3\0";
/** ~1 MiB per file, so the walk's whole memory cost is ~2 MiB no matter how large the databases are. */
const DEFAULT_CHUNK_BYTES = 1 << 20;
/**
 * Hand the event loop back every 64 MiB read.
 *
 * Measured on the deployed shared-cpu-1x: a COLD walk of the real 766 MB mirror takes **35.9 s**
 * (682 ms once the page cache is warm, 145 ms after that) — the volume reads at ~21 MB/s cold. Run as
 * one synchronous block that would stall Node's single thread for 36 s, and `GET /healthz` — Fly's
 * service check, `timeout = "5s"` — would time out repeatedly and pull the machine out of routing
 * DURING an ingest. Yielding costs nothing measurable and removes that entirely.
 */
const DEFAULT_YIELD_BYTES = 64 << 20;
const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Page size from a SQLite header: bytes 16-17, big-endian u16.
 *
 * **Not assumed to be 4096.** The mirror inherits whatever the phone's GRDB chose, a future migration
 * could change it, and a page protocol that guessed wrong would ship a diff of pure garbage. The
 * value 1 is SQLite's escape hatch for 65536, which does not fit in the u16 (fileformat2.html §1.3).
 */
export function parsePageSize(header: Buffer): number {
  if (header.length < SQLITE_HEADER_BYTES) throw new PageChurnError(`header is ${header.length} bytes, need ${SQLITE_HEADER_BYTES}`);
  if (header.subarray(0, 16).toString("binary") !== SQLITE_MAGIC) throw new PageChurnError("not a SQLite file (bad magic)");
  const raw = header.readUInt16BE(16);
  const size = raw === 1 ? 65536 : raw;
  // Powers of two, 512..65536. A corrupt or truncated file lands here rather than producing a
  // plausible-looking page count that would quietly poison the trend.
  if (size < 512 || size > 65536 || (size & (size - 1)) !== 0) throw new PageChurnError(`implausible page size ${raw}`);
  return size;
}

export function readSqlitePageSize(fd: number): number {
  const header = Buffer.alloc(SQLITE_HEADER_BYTES);
  const got = readFully(fd, header, SQLITE_HEADER_BYTES, 0);
  if (got < SQLITE_HEADER_BYTES) throw new PageChurnError(`file is ${got} bytes, shorter than a SQLite header`);
  return parsePageSize(header);
}

/** `readSync` may return short. Loops until `length` bytes are in `buf` or the file ends. */
function readFully(fd: number, buf: Buffer, length: number, position: number): number {
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (n <= 0) break;
    got += n;
  }
  return got;
}

export interface PageChurn {
  /** Page size of the INCOMING file. Every byte figure below is in these units. */
  pageSize: number;
  /** Page size of the outgoing mirror. Differs from `pageSize` only on a rebuild — see `pageSizeChanged`. */
  oldPageSize: number | null;
  oldPageCount: number;
  newPageCount: number;
  /** Pages present in both files (index < min(counts)) whose bytes differ. */
  pagesDiffering: number;
  /** Pages the new file has past the end of the old one. Genuinely new data; every protocol ships these. */
  pagesAdded: number;
  /** Pages the old file had past the end of the new one — a shrink, i.e. a truncate, not a payload. */
  pagesRemoved: number;
  /** Lowest / highest index a page protocol would have to send. null when nothing changed at all. */
  firstChangedPage: number | null;
  lastChangedPage: number | null;
  /** `pagesDiffering + pagesAdded` — what a page-diff upload would actually carry. */
  deltaPages: number;
  /** `deltaPages * pageSize`. Raw, uncompressed: the honest upper bound on the wire cost. */
  deltaBytes: number;
  /** `deltaPages / newPageCount` as 0-100. **The number P0 exists to produce.** */
  churnPct: number;
  /** Wall clock of the comparison itself, so its cost against a 90-150 s sync is never a guess. */
  compareMs: number;
  /** Bytes read from disk across both files. */
  bytesRead: number;
  /** The two files disagree on page size: every page moves, so no walk was attempted and churn is 100%. */
  pageSizeChanged: boolean;
  /** No previous mirror. The whole file is "added"; the row is a baseline, not a churn sample. */
  bootstrap: boolean;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/**
 * Count the pages that differ between two SQLite files, walking both at the real page size.
 *
 * Async solely so the walk can yield: the reads themselves are positional and synchronous, which is
 * what keeps memory flat, but a cold 766 MB pass is ~36 s of wall clock and Node has one thread.
 *
 * Throws on anything that would make the answer a lie (missing file, bad header, short read). Callers
 * on the ingest path use `measurePageChurn` instead, which turns every throw into a logged skip.
 */
export async function comparePageFiles(
  oldPath: string, newPath: string, opts: { chunkBytes?: number; yieldEveryBytes?: number } = {},
): Promise<PageChurn> {
  const started = performance.now();
  let oldFd = -1, newFd = -1;
  try {
    newFd = fs.openSync(newPath, "r");
    const pageSize = readSqlitePageSize(newFd);
    // File size, not the header's page count at bytes 28-31: that field is only meaningful when the
    // change counter agrees with it, and a mid-rebuild file can carry a stale value. Bytes on disk
    // are what a page protocol would actually have to move.
    const newPageCount = Math.floor(fs.fstatSync(newFd).size / pageSize);

    const done = (r: Omit<PageChurn, "compareMs" | "churnPct">): PageChurn =>
      ({ ...r, churnPct: pct(r.deltaPages, r.newPageCount), compareMs: Math.round(performance.now() - started) });

    // No mirror yet — a fresh volume or a restore. Everything is new by definition; recording it keeps
    // the trend honest (a 100% row that is NOT evidence against page replication) instead of dropping
    // the sync silently.
    if (!fs.existsSync(oldPath)) {
      return done({
        pageSize, oldPageSize: null, oldPageCount: 0, newPageCount,
        pagesDiffering: 0, pagesAdded: newPageCount, pagesRemoved: 0,
        firstChangedPage: newPageCount > 0 ? 0 : null, lastChangedPage: newPageCount > 0 ? newPageCount - 1 : null,
        deltaPages: newPageCount, deltaBytes: newPageCount * pageSize,
        bytesRead: SQLITE_HEADER_BYTES, pageSizeChanged: false, bootstrap: true,
      });
    }

    oldFd = fs.openSync(oldPath, "r");
    const oldPageSize = readSqlitePageSize(oldFd);
    const oldPageCount = Math.floor(fs.fstatSync(oldFd).size / oldPageSize);

    // A page-size change (VACUUM, a rebuild, a `PRAGMA page_size` migration) moves every byte in the
    // file. Comparing index-for-index across different page sizes would produce a meaningless number,
    // so record the fact instead — this is exactly the >40% fallback trigger §1.4 describes.
    if (oldPageSize !== pageSize) {
      return done({
        pageSize, oldPageSize, oldPageCount, newPageCount,
        pagesDiffering: 0, pagesAdded: newPageCount, pagesRemoved: 0,
        firstChangedPage: newPageCount > 0 ? 0 : null, lastChangedPage: newPageCount > 0 ? newPageCount - 1 : null,
        deltaPages: newPageCount, deltaBytes: newPageCount * pageSize,
        bytesRead: SQLITE_HEADER_BYTES * 2, pageSizeChanged: true, bootstrap: false,
      });
    }

    const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const pagesPerChunk = Math.max(1, Math.floor(chunkBytes / pageSize));
    // Allocated ONCE and reused for the whole walk. This is the entire memory story.
    const bufOld = Buffer.allocUnsafe(pagesPerChunk * pageSize);
    const bufNew = Buffer.allocUnsafe(pagesPerChunk * pageSize);

    const overlap = Math.min(oldPageCount, newPageCount);
    const yieldEvery = opts.yieldEveryBytes ?? DEFAULT_YIELD_BYTES;
    let pagesDiffering = 0, bytesRead = SQLITE_HEADER_BYTES * 2, sinceYield = 0;
    let firstChangedPage: number | null = null, lastChangedPage: number | null = null;
    const mark = (page: number) => { if (firstChangedPage === null) firstChangedPage = page; lastChangedPage = page; };

    for (let page = 0; page < overlap; page += pagesPerChunk) {
      if (sinceYield >= yieldEvery) { sinceYield = 0; await yieldToEventLoop(); }
      const pages = Math.min(pagesPerChunk, overlap - page);
      const want = pages * pageSize, at = page * pageSize;
      const gotOld = readFully(oldFd, bufOld, want, at);
      const gotNew = readFully(newFd, bufNew, want, at);
      // Both files were stat'd above, so a short read means the file changed under us or the volume
      // is failing. Either way the count would be wrong — refuse rather than record a low number.
      if (gotOld < want || gotNew < want) throw new PageChurnError(`short read at page ${page}: old ${gotOld}/${want}, new ${gotNew}/${want}`);
      bytesRead += gotOld + gotNew; sinceYield += gotOld + gotNew;
      // One memcmp over the whole chunk first. An append-ordered database leaves most of the file
      // untouched, so this skips ~1 MiB at a time and is what keeps the walk I/O-bound.
      if (bufOld.compare(bufNew, 0, want, 0, want) === 0) continue;
      for (let i = 0; i < pages; i++) {
        const s = i * pageSize, e = s + pageSize;
        if (bufOld.compare(bufNew, s, e, s, e) !== 0) { pagesDiffering++; mark(page + i); }
      }
    }

    const pagesAdded = Math.max(0, newPageCount - oldPageCount);
    const pagesRemoved = Math.max(0, oldPageCount - newPageCount);
    if (pagesAdded > 0) { if (firstChangedPage === null) firstChangedPage = oldPageCount; lastChangedPage = newPageCount - 1; }
    const deltaPages = pagesDiffering + pagesAdded;

    return done({
      pageSize, oldPageSize, oldPageCount, newPageCount,
      pagesDiffering, pagesAdded, pagesRemoved, firstChangedPage, lastChangedPage,
      deltaPages, deltaBytes: deltaPages * pageSize,
      bytesRead, pageSizeChanged: false, bootstrap: false,
    });
  } finally {
    for (const fd of [oldFd, newFd]) if (fd >= 0) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * `comparePageFiles`, but incapable of failing the caller.
 *
 * The ONE entry point the ingest path may use. A read error, a corrupt outgoing mirror, a file that
 * moved mid-walk — all of it degrades to a warning and a null, and the atomic swap proceeds byte-for-
 * byte as if this module did not exist.
 */
export async function measurePageChurn(oldPath: string, newPath: string): Promise<PageChurn | null> {
  try {
    return await comparePageFiles(oldPath, newPath);
  } catch (e) {
    console.warn("page-churn telemetry skipped:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Append one measurement to `ingestPageChurn`. Never throws: telemetry that can fail an ingest is a
 * liability, and one lost row costs nothing when the point is a trend across many syncs.
 *
 * `uploadBytes` is the COMPRESSED `.noopbak` actually received, so the row carries the comparison the
 * decision turns on — `deltaBytes` (what a page diff would have sent, uncompressed) beside it.
 */
export function recordPageChurn(db: Database.Database, c: PageChurn, uploadBytes: number, at = Math.floor(Date.now() / 1000)): void {
  try {
    db.prepare(`INSERT INTO ingestPageChurn
      (measuredAt, pageSize, oldPageSize, oldPageCount, newPageCount, pagesDiffering, pagesAdded, pagesRemoved,
       firstChangedPage, lastChangedPage, deltaPages, deltaBytes, churnPct, uploadBytes, compareMs, bytesRead,
       pageSizeChanged, bootstrap)
      VALUES (@measuredAt,@pageSize,@oldPageSize,@oldPageCount,@newPageCount,@pagesDiffering,@pagesAdded,@pagesRemoved,
              @firstChangedPage,@lastChangedPage,@deltaPages,@deltaBytes,@churnPct,@uploadBytes,@compareMs,@bytesRead,
              @pageSizeChanged,@bootstrap)`).run({
      measuredAt: at, pageSize: c.pageSize, oldPageSize: c.oldPageSize, oldPageCount: c.oldPageCount,
      newPageCount: c.newPageCount, pagesDiffering: c.pagesDiffering, pagesAdded: c.pagesAdded,
      pagesRemoved: c.pagesRemoved, firstChangedPage: c.firstChangedPage, lastChangedPage: c.lastChangedPage,
      deltaPages: c.deltaPages, deltaBytes: c.deltaBytes, churnPct: c.churnPct, uploadBytes,
      compareMs: c.compareMs, bytesRead: c.bytesRead,
      pageSizeChanged: c.pageSizeChanged ? 1 : 0, bootstrap: c.bootstrap ? 1 : 0,
    });
  } catch (e) {
    console.warn("page-churn telemetry not recorded:", e instanceof Error ? e.message : String(e));
  }
}

export interface PageChurnRow {
  measuredAt: string;
  pageSize: number;
  oldPageCount: number;
  newPageCount: number;
  pagesDiffering: number;
  pagesAdded: number;
  pagesRemoved: number;
  deltaPages: number;
  /** What a page-diff upload would have carried, uncompressed. */
  deltaBytes: number;
  /** What /ingest actually carried, compressed. The win, if there is one, is this ratio. */
  uploadBytes: number;
  churnPct: number;
  compareMs: number;
  bootstrap?: true;
  pageSizeChanged?: true;
}

/**
 * Most recent measurements, newest first — the trend, not a single sample. One sync proves nothing:
 * a page diff can look excellent on the sync right after a big one and terrible on the first sync
 * after a recompute, and only the sequence distinguishes the two.
 */
export function recentPageChurn(db: Database.Database, limit = 20): PageChurnRow[] {
  const rows = db.prepare(
    `SELECT measuredAt, pageSize, oldPageCount, newPageCount, pagesDiffering, pagesAdded, pagesRemoved,
            deltaPages, deltaBytes, churnPct, uploadBytes, compareMs, bootstrap, pageSizeChanged
     FROM ingestPageChurn ORDER BY id DESC LIMIT ?`,
  ).all(limit) as any[];
  return rows.map((r) => ({
    measuredAt: new Date(r.measuredAt * 1000).toISOString(),
    pageSize: r.pageSize, oldPageCount: r.oldPageCount, newPageCount: r.newPageCount,
    pagesDiffering: r.pagesDiffering, pagesAdded: r.pagesAdded, pagesRemoved: r.pagesRemoved,
    deltaPages: r.deltaPages, deltaBytes: r.deltaBytes, uploadBytes: r.uploadBytes,
    churnPct: r.churnPct, compareMs: r.compareMs,
    ...(r.bootstrap ? { bootstrap: true as const } : {}),
    ...(r.pageSizeChanged ? { pageSizeChanged: true as const } : {}),
  }));
}
