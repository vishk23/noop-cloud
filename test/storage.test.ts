import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import {
  diskUsage, formatBytes, listStagedArtifacts, sweepStagedArtifacts, removeStagedSet,
  isVolumeError, isStorageError, storageReport, storageFailureMessage,
} from "../src/storage.js";

const dataDir = path.join(process.cwd(), "test/.tmp/storage");
const cfg = () => ({ dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite") } as any);
beforeEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

/** A staged artifact with a controllable age, so the sweep's age guard can be exercised. */
function makeStaged(name: string, bytes: number, ageMs: number): string {
  const p = path.join(dataDir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}
const err = (code: string, message = "boom") => Object.assign(new Error(message), { code });

describe("diskUsage", () => {
  it("reports coherent totals for a real directory", () => {
    const d = diskUsage(dataDir)!;
    expect(d).not.toBeNull();
    expect(d.totalBytes).toBeGreaterThan(0);
    expect(d.freeBytes).toBeGreaterThanOrEqual(0);
    expect(d.usedBytes + d.freeBytes).toBe(d.totalBytes);
    expect(d.usedPct + d.freePct).toBeCloseTo(100, 0);
  });
  it("returns null (unknown) rather than throwing for a missing path", () => {
    expect(diskUsage(path.join(dataDir, "does/not/exist"))).toBeNull();
  });
});

describe("formatBytes", () => {
  it("renders human units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(534_204_416)).toBe("509 MB");
    expect(formatBytes(3_221_225_472)).toBe("3.0 GB");
  });
});

describe("storage error classification", () => {
  it("treats out-of-space / IO / read-only faults as VOLUME errors", () => {
    for (const c of ["ENOSPC", "EIO", "EROFS", "EDQUOT", "SQLITE_IOERR", "SQLITE_IOERR_SHMOPEN", "SQLITE_FULL", "SQLITE_CANTOPEN", "SQLITE_READONLY_DBMOVED"]) {
      expect(isVolumeError(err(c)), c).toBe(true);
      expect(isStorageError(err(c)), c).toBe(true);
    }
  });
  it("classifies the bare `disk I/O error` message even with no .code — the exact 2026-07-26 symptom", () => {
    expect(isVolumeError(new Error("disk I/O error"))).toBe(true);
    expect(isVolumeError(new Error("database or disk is full"))).toBe(true);
  });
  it("counts a corrupt DB as a storage error on reads but NOT as a volume error", () => {
    // The distinction that keeps a corrupt UPLOAD a 400 instead of a "retry later" 507.
    for (const c of ["SQLITE_CORRUPT", "SQLITE_NOTADB"]) {
      expect(isStorageError(err(c)), c).toBe(true);
      expect(isVolumeError(err(c)), c).toBe(false);
    }
  });
  it("leaves ordinary errors alone", () => {
    for (const e of [new Error("bad request"), err("SQLITE_CONSTRAINT"), err("ENOENT"), null, undefined, "nope", 42]) {
      expect(isStorageError(e)).toBe(false);
      expect(isVolumeError(e)).toBe(false);
    }
  });
});

describe("sweepStagedArtifacts", () => {
  it("lists staged main files and their sidecars, ignoring real data files", () => {
    makeStaged(".staged-aabbccddeeff.sqlite", 100, 0);
    makeStaged(".staged-aabbccddeeff.sqlite-shm", 32, 0);
    makeStaged(".staged-aabbccddeeff.sqlite-wal", 0, 0);
    fs.writeFileSync(path.join(dataDir, "mirror.sqlite"), Buffer.alloc(10));
    fs.writeFileSync(path.join(dataDir, "server.sqlite"), Buffer.alloc(10));
    expect(listStagedArtifacts(dataDir).map((a) => a.name).sort()).toEqual([
      ".staged-aabbccddeeff.sqlite", ".staged-aabbccddeeff.sqlite-shm", ".staged-aabbccddeeff.sqlite-wal",
    ]);
  });

  it("removes corpses older than the guard and reports reclaimed bytes", () => {
    makeStaged(".staged-111111111111.sqlite", 4096, 7 * 86_400_000);
    makeStaged(".staged-222222222222.sqlite", 2048, 2 * 3_600_000);
    const r = sweepStagedArtifacts(dataDir, { olderThanMs: 3_600_000 });
    expect(r.removed).toBe(2);
    expect(r.bytes).toBe(6144);
    expect(listStagedArtifacts(dataDir)).toHaveLength(0);
  });

  it("SPARES a fresh staged file — an ingest in flight must never be swept out from under", () => {
    makeStaged(".staged-333333333333.sqlite", 4096, 5_000);
    const r = sweepStagedArtifacts(dataDir, { olderThanMs: 3_600_000 });
    expect(r.removed).toBe(0);
    expect(fs.existsSync(path.join(dataDir, ".staged-333333333333.sqlite"))).toBe(true);
  });

  it("never touches mirror.sqlite or server.sqlite", () => {
    fs.writeFileSync(path.join(dataDir, "mirror.sqlite"), Buffer.alloc(10));
    fs.writeFileSync(path.join(dataDir, "server.sqlite"), Buffer.alloc(10));
    makeStaged(".staged-444444444444.sqlite", 10, 86_400_000);
    sweepStagedArtifacts(dataDir, { olderThanMs: 0 });
    expect(fs.existsSync(path.join(dataDir, "mirror.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "server.sqlite"))).toBe(true);
  });

  it("is a no-op on a missing directory rather than throwing", () => {
    expect(sweepStagedArtifacts(path.join(dataDir, "gone")).removed).toBe(0);
  });
});

describe("removeStagedSet", () => {
  it("removes the main file and both sidecars", () => {
    const p = makeStaged(".staged-555555555555.sqlite", 10, 0);
    makeStaged(".staged-555555555555.sqlite-shm", 10, 0);
    makeStaged(".staged-555555555555.sqlite-wal", 10, 0);
    removeStagedSet(p);
    expect(listStagedArtifacts(dataDir)).toHaveLength(0);
  });
  it("with includeMain:false clears only the sidecars — the post-rename success path", () => {
    const p = makeStaged(".staged-666666666666.sqlite", 10, 0);
    makeStaged(".staged-666666666666.sqlite-shm", 10, 0);
    removeStagedSet(p, { includeMain: false });
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.existsSync(`${p}-shm`)).toBe(false);
  });
  it("does not throw when nothing is there", () => {
    expect(() => removeStagedSet(path.join(dataDir, ".staged-777777777777.sqlite"))).not.toThrow();
  });
});

describe("storageReport", () => {
  it("reports mirror size, orphan bytes and last-ingest age", () => {
    fs.writeFileSync(cfg().mirrorPath, Buffer.alloc(5000));
    makeStaged(".staged-888888888888.sqlite", 1234, 86_400_000);
    const db = new Database(cfg().serverDbPath);
    db.exec("CREATE TABLE IF NOT EXISTS ingestLog (id INTEGER PRIMARY KEY AUTOINCREMENT, receivedAt INTEGER, bytes INTEGER, latestDay TEXT)");
    db.prepare("INSERT INTO ingestLog (receivedAt, bytes, latestDay) VALUES (?,?,?)").run(Math.floor(Date.now() / 1000) - 7200, 1, "2026-07-18");
    db.close();

    const r = storageReport(cfg());
    expect(r.mirror.exists).toBe(true);
    expect(r.mirror.bytes).toBe(5000);
    expect(r.stagedOrphans).toEqual({ count: 1, bytes: 1234 });
    expect(r.lastIngestAgeSeconds).toBeGreaterThanOrEqual(7200);
    expect(r.disk).not.toBeNull();
    expect(r.warnings.some((w) => w.includes("orphaned"))).toBe(true);
  });

  it("is healthy (ok, no warnings) on a fresh server that has never been ingested to", () => {
    // A never-uploaded server is NEW, not degraded — this is what keeps /healthz quiet on a fresh deploy.
    const r = storageReport(cfg());
    expect(r.mirror.exists).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("does not warn merely because a large disk is mostly used", () => {
    // Guards the real bug this replaced: a bare percentage threshold flagged a 24 GB-free dev disk.
    fs.writeFileSync(cfg().mirrorPath, Buffer.alloc(1024));
    const r = storageReport({ ...cfg(), minFreeBytes: 1024 });
    expect(r.warnings.filter((w) => w.includes("%"))).toEqual([]);
    expect(r.nextIngestFits).toBe(true);
  });

  it("predicts a REFUSED ingest before the volume is actually full", () => {
    fs.writeFileSync(cfg().mirrorPath, Buffer.alloc(1024));
    // Demand more headroom than any disk has, so nextIngestFits must go false while space remains.
    const r = storageReport({ ...cfg(), minFreeBytes: Number.MAX_SAFE_INTEGER });
    expect(r.nextIngestFits).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.warnings.some((w) => w.includes("REFUSED"))).toBe(true);
  });

  it("flags a mirror nothing has written for days", () => {
    fs.writeFileSync(cfg().mirrorPath, Buffer.alloc(10));
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    fs.utimesSync(cfg().mirrorPath, eightDaysAgo, eightDaysAgo);
    const db = new Database(cfg().serverDbPath);
    db.exec("CREATE TABLE IF NOT EXISTS ingestLog (id INTEGER PRIMARY KEY AUTOINCREMENT, receivedAt INTEGER, bytes INTEGER, latestDay TEXT)");
    db.prepare("INSERT INTO ingestLog (receivedAt, bytes, latestDay) VALUES (?,?,?)").run(Math.floor(Date.now() / 1000) - 8 * 86_400, 1, "2026-07-18");
    db.close();
    const r = storageReport(cfg());
    // 8 days is exactly what the outage looked like: mirror present, queries "working", data frozen.
    expect(r.warnings.some((w) => /mirror has not been updated for 8\.0 days/.test(w))).toBe(true);
    expect(r.ok).toBe(false);
  });

  // The counterpart, and the reason the trigger moved off `ingestLog`: under liters the phone pushes
  // page deltas and may not send a whole database for weeks, so keying this on the last /ingest
  // accused a healthy server of dropping uploads every other day (vk-noop-cloud, 2026-07-31).
  it("does not flag an old whole-DB ingest when something is still writing the mirror", () => {
    fs.writeFileSync(cfg().mirrorPath, Buffer.alloc(10)); // written just now, by whichever path
    const db = new Database(cfg().serverDbPath);
    db.exec("CREATE TABLE IF NOT EXISTS ingestLog (id INTEGER PRIMARY KEY AUTOINCREMENT, receivedAt INTEGER, bytes INTEGER, latestDay TEXT)");
    db.prepare("INSERT INTO ingestLog (receivedAt, bytes, latestDay) VALUES (?,?,?)").run(Math.floor(Date.now() / 1000) - 8 * 86_400, 1, "2026-07-18");
    db.close();
    const r = storageReport(cfg());
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
    // …and the 8-day-old upload is still REPORTED, just no longer mistaken for the mirror's age.
    expect(r.lastIngestAgeSeconds).toBeGreaterThan(7 * 86_400);
    expect(r.mirrorAgeSeconds).toBeLessThan(60);
  });

  it("still produces a report when server.sqlite is unreadable", () => {
    // The trap the outage exposed: diagnostics that need the same broken disk are no diagnostics.
    fs.mkdirSync(cfg().serverDbPath, { recursive: true }); // a directory where a DB should be
    const r = storageReport(cfg());
    expect(r.lastIngestError).toBeTruthy();
    expect(r.disk).not.toBeNull();
    expect(r.warnings.some((w) => w.includes("server.sqlite unreadable"))).toBe(true);
  });
});

describe("storageFailureMessage", () => {
  it("says it is the SERVER's fault, gives numbers, and names the fix", () => {
    fs.writeFileSync(cfg().mirrorPath, Buffer.alloc(2048));
    const msg = storageFailureMessage(cfg(), new Error("disk I/O error"));
    expect(msg).toMatch(/storage is degraded/i);
    expect(msg).toMatch(/not a bad request/i);   // stop the caller debugging their own arguments
    expect(msg).toMatch(/\/status/);             // where to look
    expect(msg).toMatch(/disk I\/O error/);      // original preserved, not swallowed
    expect(msg).toMatch(/free of/);              // real capacity numbers
  });
  it("still returns a usable message when diagnostics themselves fail", () => {
    const msg = storageFailureMessage({ dataDir: "/nonexistent", mirrorPath: "/nonexistent/m", serverDbPath: "/nonexistent/s" } as any);
    expect(msg).toMatch(/storage is degraded/i);
  });
});
