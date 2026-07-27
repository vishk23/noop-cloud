import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import Database from "better-sqlite3";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { createApp } from "../src/server.js";
import { Mirror } from "../src/mirror.js";
import { mirrorReadable, isBusyError, isVolumeError, isPayloadDbError } from "../src/storage.js";

// What changes for the 19 MCP read call sites when the mirror stops being an immutable inode
// published by rename(2) and becomes a live database written in place by the liters applier.
//
// The short answer, which these tests pin: nothing about a successful read. Every call site already
// opens read-only, closes in a `finally`, holds no transaction and spans no `await`, so SQLite's own
// rollback-journal locking serializes them against the applier for free. What is NEW is that a read
// can now be told to WAIT — and previously-impossible SQLITE_BUSY must not be mistaken for the
// 2026-07-26 signature of a degraded volume, which says "this will keep failing".

const dataDir = path.join(process.cwd(), "test/.tmp/liters-readers");
const mirrorPath = path.join(dataDir, "mirror.sqlite");
const cfg = () => ({
  dataDir, mirrorPath, serverDbPath: path.join(dataDir, "server.sqlite"),
  maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0,
} as any);

const journalBytes = (p: string) => {
  const fd = fs.openSync(p, "r");
  try { const b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 18); return [b[0], b[1]]; }
  finally { fs.closeSync(fd); }
};

beforeAll(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const zip = path.join(dataDir, "b.noopbak");
  buildNoopbak(zip);
  await ingestNoopbak(fs.readFileSync(zip), cfg());
  // Put the mirror in the shape the liters applier produces — a ROLLBACK-JOURNAL file. See the
  // `journal mode is load-bearing` block below for why this is not a test detail.
  const w = new Database(mirrorPath);
  w.pragma("journal_mode = DELETE");
  w.close();
  for (const s of ["-wal", "-shm"]) fs.rmSync(mirrorPath + s, { force: true });
});

/**
 * Holds SQLite's EXCLUSIVE lock on the mirror for the duration of `fn`, the way the liters applier
 * does while it writes pages.
 *
 * Same process on purpose: SQLite's process-global inode table makes two connections in one process
 * observe each other's locks correctly, so this reproduces the reader/writer collision without a
 * second process. (The CROSS-process case — a real Node reader against the real Rust applier — is
 * covered in liters-sink/tests/contention.rs, because POSIX record locks are what that one is
 * actually about.)
 */
async function whileLocked<T>(fn: () => Promise<T> | T): Promise<T> {
  const writer = new Database(mirrorPath);
  try {
    writer.exec("BEGIN EXCLUSIVE");
    return await fn();
  } finally {
    try { writer.exec("ROLLBACK"); } catch { /* already gone */ }
    writer.close();
  }
}

describe("SQLITE_BUSY is its own category", () => {
  it("is not classified as a volume fault or a corrupt payload", () => {
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    expect(isBusyError(busy)).toBe(true);
    // Both of the existing categories tell the caller something FALSE about a busy mirror: one says
    // the disk is broken and the same call will keep failing, the other says the bytes are corrupt.
    expect(isVolumeError(busy)).toBe(false);
    expect(isPayloadDbError(busy)).toBe(false);

    expect(isBusyError(Object.assign(new Error("x"), { code: "SQLITE_BUSY_SNAPSHOT" }))).toBe(true);
    expect(isBusyError(Object.assign(new Error("x"), { code: "SQLITE_IOERR_WRITE" }))).toBe(false);
    expect(isBusyError(Object.assign(new Error("x"), { code: "SQLITE_CORRUPT" }))).toBe(false);
    expect(isBusyError(new Error("plain"))).toBe(false);
  });
});

describe("journal mode is load-bearing, not cosmetic", () => {
  it("the liters mirror is a rollback-journal file, which is what makes the lock protocol apply", () => {
    // 1 = rollback journal, 2 = WAL. liters' incremental applier stamps these bytes on page 1
    // (`apply_spooled`) precisely so that its `fcntl` PENDING/SHARED locks — the rollback-journal
    // lock protocol — are the same ones SQLite readers take. A WAL-mode reader takes NEITHER, so
    // applier and reader would not be serialized against each other at all.
    expect(journalBytes(mirrorPath)).toEqual([1, 1]);
    expect(fs.existsSync(`${mirrorPath}-wal`)).toBe(false);
  });

  it("a WAL-mode mirror gives a reader NO protection from a concurrent writer — the reason mirrorfix.rs exists", async () => {
    // The state `/ingest` leaves behind: the phone's GRDB database is WAL-mode, and a `.noopbak`
    // carries that header through unchanged. liters' FULL-RESTORE path (`decode_database_to`) also
    // preserves the source header, unlike its incremental path — so without the sink's fixup, a
    // freshly restored mirror lands in exactly this state.
    const walMirror = path.join(dataDir, "wal-mirror.sqlite");
    fs.copyFileSync(mirrorPath, walMirror);
    const w = new Database(walMirror);
    w.pragma("journal_mode = WAL");
    expect(journalBytes(walMirror)).toEqual([2, 2]);

    w.exec("BEGIN EXCLUSIVE");
    try {
      // Reads sail straight through a writer's EXCLUSIVE lock. That is correct WAL behaviour and
      // completely wrong for a file whose pages are being overwritten underneath the reader.
      const v = mirrorReadable(walMirror);
      expect(v.ok).toBe(true);
      expect(v.busy).toBeUndefined();
    } finally { w.exec("ROLLBACK"); w.close(); }
    for (const s of ["-wal", "-shm"]) fs.rmSync(walMirror + s, { force: true });

    // …and a `{readonly: true}` connection CREATES a WAL index beside the database, on the data
    // volume. `SQLITE_OPEN_READONLY` restricts writes to the database, not to its sidecars.
    // Measured, not assumed — and it means that today, before any of this, every MCP read against
    // the WAL-headed mirror `/ingest` produces is making files on a volume that has been to zero.
    const reader = new Database(walMirror, { readonly: true, fileMustExist: true });
    try {
      reader.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
      expect(fs.existsSync(`${walMirror}-shm`)).toBe(true);
    } finally { reader.close(); }
  });
});

describe("the health probe under an in-place apply", () => {
  it("reports busy, NOT degraded, while the applier holds the write lock", async () => {
    const verdict = await whileLocked(() => mirrorReadable(mirrorPath));
    // A degraded verdict here would flip /healthz red every time a large delta landed, and Fly's
    // service check would pull a perfectly healthy machine out of routing for doing its job.
    expect(verdict.ok).toBe(true);
    expect(verdict.busy).toBe(true);
    expect(verdict.error).toBeUndefined();
  }, 20_000);

  it("waits well inside Fly's 5s check budget rather than the driver's 5s default", async () => {
    const started = Date.now();
    await whileLocked(() => mirrorReadable(mirrorPath));
    const waited = Date.now() - started;
    // fly.toml gives /healthz `timeout = "5s"`. better-sqlite3's default busy_timeout is also 5000,
    // so an un-tuned probe would time out the CHECK instead of returning a verdict.
    expect(waited).toBeLessThan(4_000);
  }, 20_000);

  it("still detects a genuinely unreadable mirror", () => {
    const broken = path.join(dataDir, "broken.sqlite");
    fs.writeFileSync(broken, Buffer.alloc(8192, 0xab));
    const v = mirrorReadable(broken);
    expect(v.ok).toBe(false);
    expect(v.busy).toBeUndefined();
  });

  it("GET /healthz stays 200 and un-degraded through a lock hold", async () => {
    const app = createApp(cfg());
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const body = await whileLocked(() => new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
          let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d));
        }).on("error", reject);
      }));
      expect(JSON.parse(body)).toEqual({ ok: true });
    } finally { server.close(); }
  }, 20_000);
});

describe("Mirror's reader contract is unchanged", () => {
  it("defaults to exactly the options every tool call site has always used", () => {
    // No `timeout` key means better-sqlite3's 5000ms default: long enough to sit out any realistic
    // apply. All 20 tool call sites construct `new Mirror(path)` and are unaffected by the new arg.
    const m = new Mirror(mirrorPath);
    try { expect(m.hasTable("dailyMetric")).toBe(true); } finally { m.close(); }
  });

  it("opens read-only: a reader can never write to the mirror the applier owns", () => {
    const m = new Mirror(mirrorPath);
    try {
      expect(() => (m as any).db.exec("CREATE TABLE nope (x)")).toThrow(/readonly|read-only/i);
    } finally { m.close(); }
  });
});

describe("/status carries the replication position", () => {
  it("reports liters as disabled when it is", async () => {
    const app = createApp(cfg());
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http.get({ port, path: "/status", headers: { authorization: `Bearer ${cfg().roToken}` } }, (res) => {
          let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d));
        }).on("error", reject);
      });
      const j = JSON.parse(body);
      expect(j.liters).toEqual({ enabled: false });
      // And the pre-existing report is untouched beside it.
      expect(j.mirror.exists).toBe(true);
      expect(j).toHaveProperty("nextIngestFits");
    } finally { server.close(); }
  });
});
