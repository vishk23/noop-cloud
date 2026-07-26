import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import Database from "better-sqlite3"; import AdmZip from "adm-zip";
import { buildNoopbak, buildMirrorSqlite } from "./fixtures/make-fixture.js";
import { ingestNoopbak, IngestError } from "../src/ingest.js";
import { listStagedArtifacts } from "../src/storage.js";
import { createApp } from "../src/server.js";

// Regression suite for the 2026-07-26 full-volume outage. The Fly volume reached 3.0G/3.0G with
// ~2.4 GB of it being orphaned `.staged-*` files — the temp half of ingestNoopbak's atomic swap —
// and every MCP tool then answered a bare `disk I/O error`. Each test below pins one of the defects.

const dataDir = path.join(process.cwd(), "test/.tmp/ingest-guard");
const base = () => ({
  dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"),
  maxIngestBytes: 262_144_000, minFreeBytes: 1024, stagedSweepAgeMs: 3_600_000,
  roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0,
} as any);
beforeEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

const goodUpload = () => { const z = path.join(dataDir, "in.noopbak"); buildNoopbak(z); return fs.readFileSync(z); };
const staged = () => listStagedArtifacts(dataDir).map((a) => a.name).sort();

describe("ingest disk-space preflight", () => {
  it("refuses with insufficient_space / 507 instead of starting a swap it cannot finish", () => {
    const cfg = base();
    cfg.minFreeBytes = Number.MAX_SAFE_INTEGER; // no real disk can satisfy this
    try {
      ingestNoopbak(goodUpload(), cfg);
      expect.fail("should have refused");
    } catch (e: any) {
      expect(e).toBeInstanceOf(IngestError);
      expect(e.code).toBe("insufficient_space");
      // 507, not 400: the upload was VALID. A 400 would tell the phone to discard a good backup.
      expect(e.status).toBe(507);
      expect(e.message).toMatch(/free of/);        // carries the real numbers
      expect(e.message).toMatch(/headroom/);
    }
  });

  it("leaves NO staged file behind when it refuses — the leak must not be self-amplifying", () => {
    const cfg = base();
    cfg.minFreeBytes = Number.MAX_SAFE_INTEGER;
    try { ingestNoopbak(goodUpload(), cfg); } catch { /* expected */ }
    expect(staged()).toEqual([]);
  });

  it("preserves an existing mirror when it refuses", () => {
    const cfg = base();
    ingestNoopbak(goodUpload(), cfg);
    const before = fs.statSync(cfg.mirrorPath).size;
    cfg.minFreeBytes = Number.MAX_SAFE_INTEGER;
    try { ingestNoopbak(goodUpload(), cfg); } catch { /* expected */ }
    expect(fs.statSync(cfg.mirrorPath).size).toBe(before);
    const db = new Database(cfg.mirrorPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM dailyMetric").get() as any).c).toBeGreaterThan(0);
    db.close();
  });

  it("still ingests normally when there is room", () => {
    const r = ingestNoopbak(goodUpload(), base());
    expect(r.ok).toBe(true);
    expect(r.latestDay).toBe("2026-06-13");
  });
});

describe("staged artifact cleanup", () => {
  it("opening a WAL-mode DB read-only really does create a sidecar (the leak vector is real)", () => {
    // Guards the regression test below from becoming vacuous: if SQLite stopped creating sidecars,
    // the "no orphans after ingest" assertion would pass for the wrong reason.
    const p = path.join(dataDir, "probe.sqlite");
    buildMirrorSqlite(p);
    const db = new Database(p, { readonly: true });
    db.prepare("SELECT COUNT(*) c FROM dailyMetric").get();
    const sidecars = fs.readdirSync(dataDir).filter((f) => f.startsWith("probe.sqlite-"));
    db.close();
    expect(sidecars.length).toBeGreaterThan(0);
  });

  it("leaves no -wal/-shm orphans after a SUCCESSFUL ingest", () => {
    // The rename moves only the main file, so the staged sidecars used to survive every upload.
    // 34 of them had piled up on the volume by the time of the outage.
    ingestNoopbak(goodUpload(), base());
    expect(staged()).toEqual([]);
  });

  it("leaves no orphans after a REJECTED upload", () => {
    const cfg = base();
    const foreign = path.join(dataDir, "f.sqlite");
    const db = new Database(foreign); db.pragma("journal_mode = WAL"); db.exec("CREATE TABLE x(a)"); db.close();
    const z = new AdmZip(); z.addFile("noop-backup.sqlite", fs.readFileSync(foreign));
    try { ingestNoopbak(z.toBuffer(), cfg); expect.fail("should reject"); }
    catch (e: any) { expect(e.code).toBe("foreign_db"); }
    expect(staged()).toEqual([]);
  });

  it("keeps a corrupt upload a 400 — never a 507 'retry later'", () => {
    // Misclassifying this would have the phone re-send the same broken bytes forever.
    const cfg = base();
    const bad = Buffer.concat([Buffer.from("SQLite format 3\0", "binary"), Buffer.alloc(4096, 0xab)]);
    const z = new AdmZip(); z.addFile("noop-backup.sqlite", bad);
    try { ingestNoopbak(z.toBuffer(), cfg); expect.fail("should reject"); }
    catch (e: any) {
      expect(e).toBeInstanceOf(IngestError);
      expect(e.status).toBe(400);
      expect(e.code).toBe("corrupt_sqlite");
    }
    expect(staged()).toEqual([]);
  });

  it("sweeps crash corpses from a previous boot on the next ingest", () => {
    const cfg = base();
    for (const n of [".staged-aaaaaaaaaaaa.sqlite", ".staged-aaaaaaaaaaaa.sqlite-shm", ".staged-bbbbbbbbbbbb.sqlite"]) {
      const p = path.join(dataDir, n);
      fs.writeFileSync(p, Buffer.alloc(2048));
      const old = new Date(Date.now() - 5 * 86_400_000);
      fs.utimesSync(p, old, old);
    }
    expect(staged()).toHaveLength(3);
    ingestNoopbak(goodUpload(), cfg);
    expect(staged()).toEqual([]);
  });

  it("does not sweep a staged file young enough to belong to an in-flight upload", () => {
    const cfg = base();
    const fresh = path.join(dataDir, ".staged-cccccccccccc.sqlite");
    fs.writeFileSync(fresh, Buffer.alloc(1024));
    ingestNoopbak(goodUpload(), cfg);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe("POST /ingest status codes", () => {
  function post(port: number, body: Buffer, token: string): Promise<{ status: number; json: any }> {
    return new Promise((resolve) => {
      const r = http.request({ port, path: "/ingest", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "content-length": body.length } }, (res) => {
        let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: d ? JSON.parse(d) : null }));
      });
      r.end(body);
    });
  }

  it("answers 507 with detail when the volume cannot fit the upload", async () => {
    const cfg = base();
    cfg.minFreeBytes = Number.MAX_SAFE_INTEGER;
    const app = createApp(cfg); const server = app.listen(0); const port = (server.address() as any).port;
    const { status, json } = await post(port, goodUpload(), cfg.rwToken);
    server.close();
    expect(status).toBe(507);
    expect(json.error).toBe("insufficient_space");
    expect(json.detail).toMatch(/free of/);
  });

  it("answers 200 when there is room", async () => {
    const cfg = base();
    const app = createApp(cfg); const server = app.listen(0); const port = (server.address() as any).port;
    const { status, json } = await post(port, goodUpload(), cfg.rwToken);
    server.close();
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });
});
