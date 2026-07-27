import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http"; import zlib from "node:zlib";
import Database from "better-sqlite3"; import AdmZip from "adm-zip";
import { buildNoopbak, buildMirrorSqlite, buildNoopbakFrom } from "./fixtures/make-fixture.js";
import { ingestNoopbak, ingestNoopbakFile, IngestError, latestIngest } from "../src/ingest.js";
import { listStagedArtifacts } from "../src/storage.js";
import { readCentralDirectory, extractEntryToFile } from "../src/zipstream.js";
import { createApp } from "../src/server.js";

// Regression suite for the 2026-07-26 OOM. /ingest used to buffer the whole .noopbak with
// express.raw, hand it to AdmZip, and call getData() — three full copies of a 600 MB database in a
// 2 GB machine. The kernel killed node mid-request and the phone got a 502; it had not synced for
// 10 days by the time this was diagnosed. Measured on VK's real database size (603 MB in a 203 MB
// zip): peak RSS 1993 MB before, 232 MB after, for three ingests back to back.
//
// These tests pin the properties that keep it fixed: nothing proportional to the upload is ever
// resident, oversized uploads are refused without inflating anything, and no path — success,
// rejection, or a client hanging up mid-upload — leaves a `.staged-*` artifact on the volume.

const dataDir = path.join(process.cwd(), "test/.tmp/ingest-streaming");
const base = () => ({
  dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"),
  maxIngestBytes: 262_144_000, minFreeBytes: 1024, stagedSweepAgeMs: 3_600_000,
  roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0,
} as any);
beforeEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

const goodUploadPath = () => { const z = path.join(dataDir, "in.noopbak"); buildNoopbak(z); return z; };
const goodUpload = () => fs.readFileSync(goodUploadPath());
const staged = () => listStagedArtifacts(dataDir).map((a) => a.name).sort();

/**
 * Waits (bounded) for the staged set to drain.
 *
 * The property under test is "an aborted upload leaves NO orphan behind", which is inherently
 * eventual: the server only learns the client hung up when the socket closes, and the `finally` that
 * unlinks the body runs after that. A fixed sleep encodes a guess about how fast that happens, and
 * on a loaded machine the guess is wrong — which is a flaky test, not a caught bug. Polling asserts
 * exactly the same property without the guess, and still fails outright if the orphan really is left.
 */
async function expectNoStagedOrphans(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && staged().length > 0) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(staged()).toEqual([]);
}

/** Runs `fn` against a listening app, always closing the server. */
async function withApp(cfg: any, fn: (port: number) => Promise<void>): Promise<void> {
  const server = createApp(cfg).listen(0);
  try { await fn((server.address() as any).port); } finally { server.close(); }
}

function post(port: number, body: Buffer, token: string, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const r = http.request({
      port, path: "/ingest", method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "content-length": body.length, ...extra },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode!, json: d ? JSON.parse(d) : null }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

describe("streamed /ingest", () => {
  it("accepts a real upload over HTTP and swaps the mirror — no express.raw in the path", async () => {
    const cfg = base();
    await withApp(cfg, async (port) => {
      const { status, json } = await post(port, goodUpload(), cfg.rwToken);
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.latestDay).toBe("2026-06-13");
    });
    const db = new Database(base().mirrorPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM dailyMetric").get() as any).c).toBeGreaterThan(0);
    db.close();
    expect(staged()).toEqual([]);
  });

  it("streams the body to the volume instead of buffering it in memory", async () => {
    // The property, not the implementation: while the request is in flight there is a `.staged-*`
    // file on disk growing with the upload. Under express.raw those bytes lived in a Buffer and the
    // data dir stayed empty until the very end.
    const cfg = base();
    const body = Buffer.concat([goodUpload(), Buffer.alloc(3 * 1024 * 1024)]); // padded: big enough to span several chunks
    let sawStagedBody = false;
    await withApp(cfg, async (port) => {
      await new Promise<void>((resolve, reject) => {
        const r = http.request({
          port, path: "/ingest", method: "POST",
          headers: { authorization: `Bearer ${cfg.rwToken}`, "content-type": "application/octet-stream", "content-length": body.length },
        }, (res) => { res.resume(); res.on("end", () => resolve()); });
        r.on("error", reject);
        // First half, then watch the volume before sending the rest. Polled rather than sampled
        // once: "the bytes reached the socket" and "the server flushed them to disk" are different
        // moments, and only the second one is the claim being made.
        r.write(body.subarray(0, body.length >> 1), async () => {
          for (let i = 0; i < 100 && !sawStagedBody; i++) {
            sawStagedBody = listStagedArtifacts(dataDir).some((a) => a.name.endsWith(".noopbak") && a.bytes > 0);
            if (!sawStagedBody) await new Promise((s) => setTimeout(s, 20));
          }
          r.end(body.subarray(body.length >> 1));
        });
      });
    });
    expect(sawStagedBody).toBe(true);
    expect(staged()).toEqual([]); // and it is cleaned up afterwards
  });

  it("refuses an oversized body from Content-Length alone, before reading it", async () => {
    const cfg = base(); cfg.maxIngestBytes = 4096;
    await withApp(cfg, async (port) => {
      const { status, json } = await post(port, Buffer.alloc(64 * 1024), cfg.rwToken);
      expect(status).toBe(413);
      expect(json).toEqual({ error: "too_large" });
    });
    expect(staged()).toEqual([]);
    expect(fs.existsSync(base().mirrorPath)).toBe(false);
  });

  it("refuses an oversized body that lies about (or omits) Content-Length, mid-stream", async () => {
    const cfg = base(); cfg.maxIngestBytes = 64 * 1024;
    await withApp(cfg, async (port) => {
      const { status, json } = await new Promise<{ status: number; json: any }>((resolve, reject) => {
        const r = http.request({
          port, path: "/ingest", method: "POST",
          // chunked: no Content-Length for the fast path to check, so the ceiling has to hold while streaming
          headers: { authorization: `Bearer ${cfg.rwToken}`, "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
        }, (res) => {
          let d = ""; res.on("data", (c) => (d += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: d ? JSON.parse(d) : null }));
        });
        r.on("error", reject);
        for (let i = 0; i < 8; i++) r.write(Buffer.alloc(32 * 1024, i));
        r.end();
      });
      expect(status).toBe(413);
      expect(json).toEqual({ error: "too_large" });
    });
    // The partial body must not survive as a leaked staged file — that leak is what filled the volume.
    expect(staged()).toEqual([]);
  });

  it("rejects a decompressed database over the ceiling WITHOUT inflating it", async () => {
    // In production the zip declares 603 MB of output against a 1 GiB ceiling; here the fixture's
    // own numbers stand in. It must be refused from the central directory — a header read — rather
    // than by inflating the entry and measuring the result.
    const cfg = base();
    const zip = goodUploadPath();
    const fd = fs.openSync(zip, "r");
    const declared = readCentralDirectory(fd, fs.statSync(zip).size).find((e) => e.name.endsWith(".sqlite"))!.uncompressedSize;
    fs.closeSync(fd);
    cfg.maxIngestBytes = Math.floor(declared / 2);
    // The BODY has to stay under the ceiling, or this would prove the wrong check.
    expect(fs.statSync(zip).size).toBeLessThan(cfg.maxIngestBytes);
    try {
      await ingestNoopbakFile(zip, cfg);
      expect.fail("should have refused");
    } catch (e: any) {
      expect(e).toBeInstanceOf(IngestError);
      expect(e.code).toBe("too_large");
      expect(e.status).toBe(413); // 413, like the body-size refusal — same fact, same code
    }
    expect(staged()).toEqual([]);
  });

  it("bounds the OUTPUT even when the zip lies about the entry's size (zip bomb)", async () => {
    // The central directory's uncompressedSize is attacker-controlled — it can be forged to 0 to
    // skip the declared-size check entirely. The inflate itself has to stop at the ceiling.
    const bomb = path.join(dataDir, "bomb.noopbak");
    const raw = Buffer.concat([Buffer.from("SQLite format 3\0", "binary"), Buffer.alloc(4 * 1024 * 1024, 0)]);
    writeZipWithForgedSizes(bomb, "noop-backup.sqlite", raw, { uncompressedSize: 0 });

    const cfg = base(); cfg.maxIngestBytes = 512 * 1024;
    try {
      await ingestNoopbakFile(bomb, cfg);
      expect.fail("should have refused");
    } catch (e: any) {
      expect(e.code).toBe("too_large");
    }
    expect(staged()).toEqual([]);
    // Nothing near the claimed 4 MB was ever written.
    expect(fs.existsSync(cfg.mirrorPath)).toBe(false);
  });

  it("still checks the SQLite magic — and now on the first chunk, not after a full inflate", async () => {
    const notADb = path.join(dataDir, "notadb.noopbak");
    const z = new AdmZip(); z.addFile("noop-backup.sqlite", Buffer.alloc(1024 * 1024, 0x7e)); z.writeZip(notADb);
    try {
      await ingestNoopbakFile(notADb, base());
      expect.fail("should have refused");
    } catch (e: any) {
      expect(e.code).toBe("bad_magic");
      expect(e.status).toBe(400);
    }
    expect(staged()).toEqual([]);
  });

  it("maps a corrupt DEFLATE stream to 400 bad_zip, not a 500", async () => {
    const broken = path.join(dataDir, "broken.noopbak");
    const raw = Buffer.concat([Buffer.from("SQLite format 3\0", "binary"), Buffer.alloc(200_000, 0x11)]);
    writeZipWithForgedSizes(broken, "noop-backup.sqlite", raw, { corruptPayload: true });
    try {
      await ingestNoopbakFile(broken, base());
      expect.fail("should have refused");
    } catch (e: any) {
      expect(e).toBeInstanceOf(IngestError);
      expect(e.code).toBe("bad_zip");
      expect(e.status).toBe(400);
    }
    expect(staged()).toEqual([]);
  });

  it("leaves no .staged-* orphan when the client aborts mid-upload", async () => {
    // A backgrounded phone or a dropped cellular connection. The half-written body is exactly the
    // shape of file that filled the volume to 0 bytes free on 2026-07-26.
    const cfg = base();
    const body = goodUpload();
    await withApp(cfg, async (port) => {
      await new Promise<void>((resolve) => {
        const r = http.request({
          port, path: "/ingest", method: "POST",
          headers: { authorization: `Bearer ${cfg.rwToken}`, "content-type": "application/octet-stream", "content-length": body.length * 2 },
        });
        r.on("error", () => resolve()); // the abort surfaces here on the client side
        r.write(body.subarray(0, body.length >> 1), () => { r.destroy(); resolve(); });
      });
      await expectNoStagedOrphans(); // let the server observe the close, then check
    });
    await expectNoStagedOrphans();
    expect(fs.existsSync(cfg.mirrorPath)).toBe(false); // and nothing was half-swapped into place
  });

  it("keeps an existing mirror intact when an upload aborts", async () => {
    const cfg = base();
    await withApp(cfg, async (port) => {
      expect((await post(port, goodUpload(), cfg.rwToken)).status).toBe(200);
      const before = fs.statSync(cfg.mirrorPath).size;
      const body = goodUpload();
      await new Promise<void>((resolve) => {
        const r = http.request({
          port, path: "/ingest", method: "POST",
          headers: { authorization: `Bearer ${cfg.rwToken}`, "content-type": "application/octet-stream", "content-length": body.length * 2 },
        });
        r.on("error", () => resolve());
        r.write(body.subarray(0, 4096), () => { r.destroy(); resolve(); });
      });
      await expectNoStagedOrphans();
      expect(fs.statSync(cfg.mirrorPath).size).toBe(before);
    });
    await expectNoStagedOrphans();
  });

  it("sweeps a leaked .noopbak body from a previous crash", async () => {
    // The upload body is a file on the volume now, so the sweep has to reclaim it too — not just
    // the .sqlite half of the swap.
    const cfg = base();
    const corpse = path.join(dataDir, ".staged-deadbeef0001.noopbak");
    fs.writeFileSync(corpse, Buffer.alloc(4096));
    const old = new Date(Date.now() - 5 * 86_400_000);
    fs.utimesSync(corpse, old, old);
    expect(staged()).toEqual([".staged-deadbeef0001.noopbak"]);
    await ingestNoopbak(goodUpload(), cfg);
    expect(staged()).toEqual([]);
    expect(fs.existsSync(corpse)).toBe(false);
  });

  it("records the ingest and reports the upload's byte count", async () => {
    const cfg = base();
    const body = goodUpload();
    await withApp(cfg, async (port) => {
      const { json } = await post(port, body, cfg.rwToken, { "x-phone-timezone": "America/New_York" });
      expect(json.bytes).toBe(body.length);
    });
    expect(latestIngest(cfg)?.bytes).toBe(body.length);
    expect(latestIngest(cfg)?.phoneTz).toBe("America/New_York");
  });

  it("handles a STORED (uncompressed) entry as well as a deflated one", async () => {
    // ZIPFoundation compresses, but a stored entry is a legal .noopbak and used to work through
    // adm-zip. Losing that silently would be a regression only a user with an odd exporter would hit.
    const src = path.join(dataDir, "src.sqlite"); buildMirrorSqlite(src);
    const zipPath = path.join(dataDir, "stored.noopbak");
    const z = new AdmZip();
    z.addFile("noop-backup.sqlite", fs.readFileSync(src), "", 0);
    (z.getEntries()[0] as any).header.method = 0; // stored
    z.writeZip(zipPath);
    const r = await ingestNoopbakFile(zipPath, base());
    expect(r.ok).toBe(true);
    expect(r.latestDay).toBe("2026-06-13");
  });

  it("finds the .sqlite entry when it is not the first one in the archive", async () => {
    // The phone writes settings.json alongside the database (#1000). Entry ORDER is not a contract.
    const src = path.join(dataDir, "src2.sqlite"); buildMirrorSqlite(src);
    const zipPath = path.join(dataDir, "multi.noopbak");
    const z = new AdmZip();
    z.addFile("settings.json", Buffer.from(JSON.stringify({ weightKg: 70 })));
    z.addFile("noop-backup.sqlite", fs.readFileSync(src));
    z.writeZip(zipPath);
    const r = await ingestNoopbakFile(zipPath, base());
    expect(r.ok).toBe(true);
    expect(r.latestDay).toBe("2026-06-13");
  });
});

describe("zipstream", () => {
  it("reads the central directory of an adm-zip archive and extracts by streaming", async () => {
    const src = path.join(dataDir, "z.sqlite"); buildMirrorSqlite(src);
    const zipPath = path.join(dataDir, "z.noopbak"); buildNoopbakFrom(src, zipPath);
    const fd = fs.openSync(zipPath, "r");
    try {
      const entries = readCentralDirectory(fd, fs.statSync(zipPath).size);
      expect(entries.map((e) => e.name)).toContain("noop-backup.sqlite");
      const entry = entries.find((e) => e.name.endsWith(".sqlite"))!;
      expect(entry.uncompressedSize).toBe(fs.statSync(src).size);

      const out = path.join(dataDir, "out.sqlite");
      const written = await extractEntryToFile(zipPath, fd, fs.statSync(zipPath).size, entry, out, { maxBytes: 1 << 30 });
      expect(written).toBe(entry.uncompressedSize);
      // Byte-identical to the source database, which is the only real correctness proof here.
      expect(fs.readFileSync(out).equals(fs.readFileSync(src))).toBe(true);
    } finally { fs.closeSync(fd); }
  });

  it("rejects a file that is not a zip at all", () => {
    const p = path.join(dataDir, "nope.bin"); fs.writeFileSync(p, Buffer.alloc(5000, 0x33));
    const fd = fs.openSync(p, "r");
    try {
      expect(() => readCentralDirectory(fd, 5000)).toThrow(/end-of-central-directory/);
    } finally { fs.closeSync(fd); }
  });
});

/**
 * Minimal zip writer for the hostile cases adm-zip will not produce: a forged uncompressedSize (the
 * zip-bomb vector) and a payload whose DEFLATE stream is corrupt.
 */
function writeZipWithForgedSizes(
  dest: string, name: string, raw: Buffer,
  opts: { uncompressedSize?: number; corruptPayload?: boolean } = {},
): void {
  const nameBuf = Buffer.from(name);
  let payload = zlib.deflateRawSync(raw);
  if (opts.corruptPayload) { payload = Buffer.from(payload); payload.fill(0xff, 8, Math.min(payload.length, 64)); }
  const declared = opts.uncompressedSize ?? raw.length;

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(8, 8);
  lfh.writeUInt32LE(0, 14); lfh.writeUInt32LE(payload.length, 18); lfh.writeUInt32LE(declared, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(0, 16); cd.writeUInt32LE(payload.length, 20); cd.writeUInt32LE(declared, 24);
  cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(0, 42);

  const cdOffset = lfh.length + nameBuf.length + payload.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + nameBuf.length, 12); eocd.writeUInt32LE(cdOffset, 16);

  fs.writeFileSync(dest, Buffer.concat([lfh, nameBuf, payload, cd, nameBuf, eocd]));
}
