import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import Database from "better-sqlite3";
import { buildMirrorSqlite, buildNoopbakFrom } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { openServerDb } from "../src/serverdb.js";
import { storageReport } from "../src/storage.js";
import { createApp } from "../src/server.js";
import {
  parsePageSize, comparePageFiles, measurePageChurn, recordPageChurn, recentPageChurn, PageChurnError,
} from "../src/pagechurn.js";

// P0 of docs/SYNC_BUILD_VS_BUY.md. These tests exist to make one number trustworthy: the fraction of
// SQLite pages that actually change between two of VK's syncs. If that number is wrong the wrong
// architecture gets built for weeks, so every count below is pinned against a synthetic pair whose
// differences are known exactly — and the last group pins the property that matters even more, that
// a measurement failure of ANY kind still lets the upload through.

const dataDir = path.join(process.cwd(), "test/.tmp/pagechurn");
const cfg = () => ({
  dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"),
  maxIngestBytes: 262_144_000, minFreeBytes: 1024, stagedSweepAgeMs: 3_600_000,
  roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0,
} as any);
beforeEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

/**
 * A file that looks like a SQLite database to the header parser, with one known fill byte per page.
 * Synthetic rather than real so "these two files differ in exactly pages 3 and 7" is a fact of the
 * fixture rather than something inferred from SQLite's B-tree behaviour.
 */
function writePageFile(p: string, pageSize: number, fills: number[]): string {
  const buf = Buffer.alloc(pageSize * fills.length);
  fills.forEach((v, i) => buf.fill(v, i * pageSize, (i + 1) * pageSize));
  if (fills.length) {
    buf.write("SQLite format 3\0", 0, "binary");
    buf.writeUInt16BE(pageSize === 65536 ? 1 : pageSize, 16);
  }
  fs.writeFileSync(p, buf);
  return p;
}
const f = (name: string) => path.join(dataDir, name);

describe("parsePageSize — read it, never assume 4096", () => {
  const header = (raw: number, magic = "SQLite format 3\0") => {
    const b = Buffer.alloc(100); b.write(magic, 0, "binary"); b.writeUInt16BE(raw, 16); return b;
  };
  it("reads the declared page size from bytes 16-17, big-endian", async () => {
    expect(parsePageSize(header(4096))).toBe(4096);
    expect(parsePageSize(header(512))).toBe(512);
    expect(parsePageSize(header(32768))).toBe(32768);
  });
  it("decodes the value 1 as 65536 (SQLite's u16 escape hatch)", async () => {
    expect(parsePageSize(header(1))).toBe(65536);
  });
  it("rejects a non-SQLite file, an implausible size, and a short header", async () => {
    expect(() => parsePageSize(header(4096, "NOT a sqlite f\0\0"))).toThrow(PageChurnError);
    expect(() => parsePageSize(header(3000))).toThrow(PageChurnError); // not a power of two
    expect(() => parsePageSize(header(256))).toThrow(PageChurnError);  // below the 512 floor
    expect(() => parsePageSize(Buffer.alloc(40))).toThrow(PageChurnError);
  });
});

describe("comparePageFiles — known differences", () => {
  it("identical files differ in zero pages", async () => {
    const fills = [1, 2, 3, 4, 5, 6, 7, 8];
    const r = await comparePageFiles(writePageFile(f("a.db"), 4096, fills), writePageFile(f("b.db"), 4096, fills));
    expect(r.pagesDiffering).toBe(0);
    expect(r.pagesAdded).toBe(0);
    expect(r.pagesRemoved).toBe(0);
    expect(r.deltaPages).toBe(0);
    expect(r.deltaBytes).toBe(0);
    expect(r.churnPct).toBe(0);
    expect(r.firstChangedPage).toBeNull();
    expect(r.lastChangedPage).toBeNull();
    expect(r.oldPageCount).toBe(8);
    expect(r.newPageCount).toBe(8);
    expect(r.pageSize).toBe(4096);
  });

  it("one changed page counts exactly one", async () => {
    const old = [1, 2, 3, 4, 5, 6, 7, 8];
    const next = [...old]; next[5] = 99;
    const r = await comparePageFiles(writePageFile(f("a.db"), 4096, old), writePageFile(f("b.db"), 4096, next));
    expect(r.pagesDiffering).toBe(1);
    expect(r.deltaPages).toBe(1);
    expect(r.deltaBytes).toBe(4096);
    expect(r.firstChangedPage).toBe(5);
    expect(r.lastChangedPage).toBe(5);
    expect(r.churnPct).toBe(12.5); // 1 of 8
  });

  it("a change to page 0 is seen (the header page is not skipped)", async () => {
    const r = await comparePageFiles(writePageFile(f("a.db"), 4096, [1, 2, 3]), writePageFile(f("b.db"), 4096, [9, 2, 3]));
    expect(r.pagesDiffering).toBe(1);
    expect(r.firstChangedPage).toBe(0);
  });

  it("finds scattered changes across many chunks, and at chunk boundaries", async () => {
    // chunkBytes = 4 pages, so pages 0-3 / 4-7 / 8-11 ... are separate reads. Changing 3 (last of a
    // chunk), 4 (first of the next) and 10 (interior) catches an off-by-one in the chunk arithmetic,
    // which is the one bug in here that would silently under-report churn.
    const old = Array.from({ length: 14 }, (_, i) => i + 1);
    const next = [...old]; next[3] = 200; next[4] = 201; next[10] = 202;
    const r = await comparePageFiles(writePageFile(f("a.db"), 4096, old), writePageFile(f("b.db"), 4096, next), { chunkBytes: 4 * 4096 });
    expect(r.pagesDiffering).toBe(3);
    expect(r.firstChangedPage).toBe(3);
    expect(r.lastChangedPage).toBe(10);
    expect(r.bytesRead).toBeGreaterThanOrEqual(14 * 4096 * 2);
  });

  it("counts growth as added pages, not as differing ones", async () => {
    const old = [1, 2, 3, 4];
    const next = [1, 2, 3, 4, 5, 6, 7]; // append-only: 3 new pages, nothing rewritten
    const r = await comparePageFiles(writePageFile(f("a.db"), 4096, old), writePageFile(f("b.db"), 4096, next));
    expect(r.pagesDiffering).toBe(0);
    expect(r.pagesAdded).toBe(3);
    expect(r.pagesRemoved).toBe(0);
    expect(r.deltaPages).toBe(3);
    expect(r.deltaBytes).toBe(3 * 4096);
    expect(r.firstChangedPage).toBe(4);
    expect(r.lastChangedPage).toBe(6);
    expect(r.churnPct).toBe(42.9); // 3 of 7
  });

  it("counts growth AND rewrites together — the realistic shape", async () => {
    const old = [1, 2, 3, 4, 5];
    const next = [1, 77, 3, 4, 5, 6, 7]; // one interior rewrite + 2 appended
    const r = await comparePageFiles(writePageFile(f("a.db"), 4096, old), writePageFile(f("b.db"), 4096, next));
    expect(r.pagesDiffering).toBe(1);
    expect(r.pagesAdded).toBe(2);
    expect(r.deltaPages).toBe(3);
    expect(r.firstChangedPage).toBe(1);
    expect(r.lastChangedPage).toBe(6);
  });

  it("counts a shrink as removed pages, which cost no payload", async () => {
    const r = await comparePageFiles(writePageFile(f("a.db"), 4096, [1, 2, 3, 4, 5, 6]), writePageFile(f("b.db"), 4096, [1, 2, 3]));
    expect(r.pagesRemoved).toBe(3);
    expect(r.pagesAdded).toBe(0);
    expect(r.pagesDiffering).toBe(0);
    expect(r.deltaPages).toBe(0); // a truncate is two integers on the wire, not pages
    expect(r.churnPct).toBe(0);
  });

  it("handles a non-4096 page size end to end", async () => {
    const old = [1, 2, 3, 4], next = [1, 2, 9, 4];
    const r = await comparePageFiles(writePageFile(f("a.db"), 16384, old), writePageFile(f("b.db"), 16384, next));
    expect(r.pageSize).toBe(16384);
    expect(r.oldPageCount).toBe(4);
    expect(r.pagesDiffering).toBe(1);
    expect(r.deltaBytes).toBe(16384);
  });

  it("a page-size change is recorded as 100% churn without a meaningless walk", async () => {
    // VACUUM / a rebuild / a PRAGMA page_size migration. Comparing index-for-index across different
    // page sizes would produce a number that means nothing, so the fact is recorded instead.
    const r = await comparePageFiles(writePageFile(f("a.db"), 4096, [1, 2, 3, 4]), writePageFile(f("b.db"), 8192, [1, 2, 3, 4]));
    expect(r.pageSizeChanged).toBe(true);
    expect(r.oldPageSize).toBe(4096);
    expect(r.pageSize).toBe(8192);
    expect(r.deltaPages).toBe(4);
    expect(r.churnPct).toBe(100);
    expect(r.pagesDiffering).toBe(0); // not walked, and does not pretend to have been
  });

  it("records a first-ever ingest as a bootstrap baseline, not as churn evidence", async () => {
    const r = await comparePageFiles(f("does-not-exist.db"), writePageFile(f("b.db"), 4096, [1, 2, 3, 4, 5]));
    expect(r.bootstrap).toBe(true);
    expect(r.oldPageCount).toBe(0);
    expect(r.oldPageSize).toBeNull();
    expect(r.pagesAdded).toBe(5);
    expect(r.churnPct).toBe(100);
  });

  it("reports its own wall-clock cost", async () => {
    const r = await comparePageFiles(writePageFile(f("a.db"), 4096, [1, 2]), writePageFile(f("b.db"), 4096, [1, 3]));
    expect(r.compareMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(r.compareMs)).toBe(true);
  });
});

describe("comparePageFiles — refuses to report a number it cannot stand behind", () => {
  it("throws on a file too short to hold a SQLite header", async () => {
    fs.writeFileSync(f("trunc.db"), Buffer.alloc(40));
    await expect(comparePageFiles(writePageFile(f("a.db"), 4096, [1, 2]), f("trunc.db"))).rejects.toThrow(PageChurnError);
  });
  it("throws on a file that is not a SQLite database", async () => {
    fs.writeFileSync(f("junk.db"), Buffer.alloc(9000, 0x41));
    await expect(comparePageFiles(writePageFile(f("a.db"), 4096, [1, 2]), f("junk.db"))).rejects.toThrow(PageChurnError);
  });
  it("throws when the OUTGOING mirror is the corrupt one", async () => {
    fs.writeFileSync(f("bad-mirror.db"), Buffer.alloc(40));
    await expect(comparePageFiles(f("bad-mirror.db"), writePageFile(f("b.db"), 4096, [1, 2]))).rejects.toThrow(PageChurnError);
  });
  it("measurePageChurn converts every one of those into a null, never a throw", async () => {
    fs.writeFileSync(f("trunc.db"), Buffer.alloc(40));
    const a = writePageFile(f("a.db"), 4096, [1, 2]);
    expect(await measurePageChurn(a, f("trunc.db"))).toBeNull();
    expect(await measurePageChurn(f("trunc.db"), a)).toBeNull();
    expect(await measurePageChurn(f("gone.db"), f("also-gone.db"))).toBeNull();
    expect((await measurePageChurn(a, a))!.pagesDiffering).toBe(0); // and still measures when it can
  });
});

describe("the walk yields the event loop", () => {
  it("lets timers run while comparing, so /healthz can still be answered", async () => {
    // Measured on the deployed shared-cpu-1x: a COLD walk of the real 766 MB mirror takes 35.9 s.
    // Node has one thread and Fly's service check on GET /healthz has a 5 s timeout, so a walk that
    // held the loop for that long would pull the machine out of routing DURING an ingest. Here the
    // yield interval is dialled down to one chunk so the property is testable on a tiny fixture.
    const fills = Array.from({ length: 64 }, (_, i) => i);
    const a = writePageFile(f("a.db"), 4096, fills);
    fills[40] = 250;
    const b = writePageFile(f("b.db"), 4096, fills);

    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    try {
      const r = await comparePageFiles(a, b, { chunkBytes: 4096, yieldEveryBytes: 4096 });
      expect(r.pagesDiffering).toBe(1);
    } finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(0); // a fully synchronous walk would have starved the timer
  });
});

describe("memory is bounded, not proportional to the files", () => {
  it("compares a 64 MB pair without holding either file", async () => {
    // The 2026-07-26 outage was 1993 MB peak RSS from buffering one upload. A buffering comparison
    // would add >=64 MB here (one whole file) and most likely 128 MB; the walk's two reused ~1 MiB
    // buffers should add essentially nothing. The threshold is deliberately loose — this is a guard
    // against a regression of KIND, not a benchmark.
    const pageSize = 4096, pages = 16384; // 64 MiB each
    const fills = Array.from({ length: pages }, (_, i) => i & 0xff);
    const a = writePageFile(f("big-a.db"), pageSize, fills);
    fills[9000] = (fills[9000] + 1) & 0xff;
    const b = writePageFile(f("big-b.db"), pageSize, fills);

    const before = process.memoryUsage().rss;
    const r = await comparePageFiles(a, b);
    const grew = process.memoryUsage().rss - before;

    expect(r.pagesDiffering).toBe(1);
    expect(r.firstChangedPage).toBe(9000);
    expect(r.bytesRead).toBeGreaterThanOrEqual(2 * pageSize * pages);
    expect(grew).toBeLessThan(32 * 1024 * 1024);
  });
});

describe("persistence", () => {
  it("recordPageChurn stores a row that recentPageChurn reads back, newest first", async () => {
    const db = openServerDb(cfg());
    const base = await comparePageFiles(writePageFile(f("a.db"), 4096, [1, 2, 3, 4]), writePageFile(f("b.db"), 4096, [1, 9, 3, 4]));
    recordPageChurn(db, base, 1234, 1_700_000_000);
    recordPageChurn(db, { ...base, pagesDiffering: 2, deltaPages: 2, deltaBytes: 8192, churnPct: 50 }, 5678, 1_700_000_100);
    const rows = recentPageChurn(db);
    expect(rows).toHaveLength(2);
    expect(rows[0].churnPct).toBe(50);          // newest first
    expect(rows[0].uploadBytes).toBe(5678);
    expect(rows[1].deltaBytes).toBe(4096);
    expect(rows[1].measuredAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
    db.close();
  });

  it("recordPageChurn swallows a write failure instead of raising it into the ingest path", async () => {
    const db = new Database(":memory:"); // no ingestPageChurn table at all
    const c = await comparePageFiles(writePageFile(f("a.db"), 4096, [1]), writePageFile(f("b.db"), 4096, [2]));
    expect(() => recordPageChurn(db, c, 10)).not.toThrow();
    db.close();
  });

  it("flags bootstrap and pageSizeChanged rows so they are not read as churn samples", async () => {
    const db = openServerDb(cfg());
    recordPageChurn(db, await comparePageFiles(f("nope.db"), writePageFile(f("b.db"), 4096, [1, 2])), 99);
    const [row] = recentPageChurn(db);
    expect(row.bootstrap).toBe(true);
    expect(row.pageSizeChanged).toBeUndefined();
    db.close();
  });
});

describe("the ingest path", () => {
  /** A `.noopbak` around an exact copy of `sqlitePath`, so two uploads can be byte-identical. */
  const bakOf = (sqlitePath: string, name: string) => { const z = f(name); buildNoopbakFrom(sqlitePath, z); return fs.readFileSync(z); };

  it("records a bootstrap row on the first ingest and a churn row on the second", async () => {
    const src = f("src.sqlite"); buildMirrorSqlite(src);
    const c = cfg();
    await ingestNoopbak(bakOf(src, "one.noopbak"), c);
    let rows = (() => { const db = openServerDb(c); const r = recentPageChurn(db); db.close(); return r; })();
    expect(rows).toHaveLength(1);
    expect(rows[0].bootstrap).toBe(true);
    expect(rows[0].newPageCount).toBeGreaterThan(0);

    await ingestNoopbak(bakOf(src, "two.noopbak"), c);
    rows = (() => { const db = openServerDb(c); const r = recentPageChurn(db); db.close(); return r; })();
    expect(rows).toHaveLength(2);
    expect(rows[0].bootstrap).toBeUndefined();
  });

  it("re-uploading byte-identical bytes measures zero churn — a page protocol would send nothing", async () => {
    const src = f("src.sqlite"); buildMirrorSqlite(src);
    const c = cfg();
    await ingestNoopbak(bakOf(src, "one.noopbak"), c);
    await ingestNoopbak(bakOf(src, "two.noopbak"), c);
    const db = openServerDb(c); const [latest] = recentPageChurn(db); db.close();
    expect(latest.pagesDiffering).toBe(0);
    expect(latest.pagesAdded).toBe(0);
    expect(latest.deltaPages).toBe(0);
    expect(latest.deltaBytes).toBe(0);
    expect(latest.churnPct).toBe(0);
    expect(latest.uploadBytes).toBeGreaterThan(0); // …against a full-size upload that still happened
  });

  it("measures a real, small edit as a handful of pages against a whole-file upload", async () => {
    const src = f("src.sqlite"); buildMirrorSqlite(src);
    const c = cfg();
    await ingestNoopbak(bakOf(src, "one.noopbak"), c);

    const edited = f("edited.sqlite"); fs.copyFileSync(src, edited);
    const db2 = new Database(edited);
    db2.pragma("journal_mode = DELETE"); // keep the payload a single file, as the phone's export is
    db2.prepare("UPDATE dailyMetric SET restingHr = 49 WHERE deviceId = 'my-whoop' AND day = '2026-06-13'").run();
    db2.close();
    await ingestNoopbak(bakOf(edited, "two.noopbak"), c);

    const db = openServerDb(c); const [latest] = recentPageChurn(db); db.close();
    expect(latest.deltaPages).toBeGreaterThan(0);
    expect(latest.deltaPages).toBeLessThan(latest.newPageCount); // the whole point: not everything moved
    expect(latest.deltaBytes).toBe(latest.deltaPages * latest.pageSize);
    expect(latest.uploadBytes).toBeGreaterThan(0);
  });

  it("still ingests successfully when the outgoing mirror is corrupt and the measurement fails", async () => {
    const src = f("src.sqlite"); buildMirrorSqlite(src);
    const c = cfg();
    await ingestNoopbak(bakOf(src, "one.noopbak"), c);
    // Truncate the live mirror to garbage: measurePageChurn cannot read it, so no row can be written.
    fs.writeFileSync(c.mirrorPath, Buffer.alloc(40));

    const r = await ingestNoopbak(bakOf(src, "two.noopbak"), c);
    expect(r.ok).toBe(true);
    // The swap happened regardless, and the mirror is the new database.
    const m = new Database(c.mirrorPath, { readonly: true });
    expect((m.prepare("SELECT COUNT(*) n FROM dailyMetric").get() as any).n).toBeGreaterThan(0);
    m.close();
    const db = openServerDb(c); const rows = recentPageChurn(db); db.close();
    expect(rows).toHaveLength(1); // only the bootstrap row; the failed measurement recorded nothing
  });

  it("GET /status carries the rows, and a measurement never affects ok/healthz", async () => {
    const src = f("src.sqlite"); buildMirrorSqlite(src);
    const c = cfg();
    await ingestNoopbak(bakOf(src, "one.noopbak"), c);
    await ingestNoopbak(bakOf(src, "two.noopbak"), c);

    expect(storageReport(c, { pageChurnLimit: 20 }).pageChurn).toHaveLength(2);
    // …and absent by default, so `data_freshness` and /healthz do not carry the experiment's log.
    expect(storageReport(c).pageChurn).toBeUndefined();

    const server = createApp(c).listen(0);
    const port = (server.address() as any).port;
    const get = (p: string, token?: string) => new Promise<{ status: number; json: any }>((resolve, reject) => {
      const headers = token ? { authorization: `Bearer ${token}` } : {};
      const r = http.get({ port, path: p, headers }, (res) => {
        let d = ""; res.on("data", (x) => (d += x));
        res.on("end", () => resolve({ status: res.statusCode!, json: d ? JSON.parse(d) : null }));
      });
      r.on("error", reject);
    });
    try {
      const status = await get("/status", c.roToken);
      expect(status.status).toBe(200);
      expect(status.json.pageChurn).toHaveLength(2);
      expect(status.json.pageChurn[0].churnPct).toBe(0); // identical re-upload
      expect(status.json.pageChurn[0]).toHaveProperty("deltaBytes");
      expect(status.json.pageChurn[0]).toHaveProperty("uploadBytes");
      expect((await get("/status")).status).toBe(401);          // still behind ro
      expect((await get("/healthz")).json.degraded).toBeUndefined(); // not part of the health verdict
    } finally { server.close(); }
  });
});
