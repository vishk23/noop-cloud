import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import Database from "better-sqlite3";
import { ingestDeepBufferChunk, parseChunkStats, parseChunkHeaders, chunkKey, DeepBufError } from "../src/deepbuf.js";
import { FsObjectStore } from "../src/objectstore.js";

const dataDir = path.join(process.cwd(), "test/.tmp/deepbuf");
const objDir = path.join(dataDir, "objects");
const cfg = () => ({
  serverDbPath: path.join(dataDir, "server.sqlite"),
  maxDeepbufBytes: 25_165_824,
  maxDeepbufRawBytes: 67_108_864,
} as any);
const store = () => new FsObjectStore(objDir);

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(objDir, { recursive: true });
});

/** A JSONL body shaped exactly like PuffinDeepBufferLog's output. */
function body(n: number, opts: { startTs?: number; size?: number; imu?: boolean } = {}) {
  const { startTs = 1_752_600_000, size = 1244, imu = false } = opts;
  let s = "";
  for (let i = 0; i < n; i++) {
    const hex = "ab".repeat(64);
    const imuField = imu ? `,"imu":{"sampleCount":100,"accelEnergyG":0.12}` : "";
    s += `{"ts_ms":${(startTs + i) * 1000},"strap_ts":${startTs + i},"size":${size},"offload":true,"char":"6108","hex":"${hex}"${imuField}}\n`;
  }
  return Buffer.from(s, "utf8");
}
const deflate = (b: Buffer) => zlib.deflateRawSync(b);
const headers = (generation: string, byteStart: number, byteEnd: number) => ({ generation, byteStart, byteEnd });

describe("parseChunkStats", () => {
  it("counts the two buffer families separately", () => {
    // The whole point: 1244 = decoded 6-axis IMU, 2140 = the still-undecoded optical/PPG layout.
    // "Do I have the optical buffers for that night" is the actual research question (#423).
    const b = Buffer.concat([body(3, { size: 1244 }), body(2, { size: 2140, startTs: 1_752_600_010 })]);
    const s = parseChunkStats(b);
    expect(s.lines).toBe(5);
    expect(s.n1244).toBe(3);
    expect(s.n2140).toBe(2);
    expect(s.nOther).toBe(0);
  });

  it("tracks the strap_ts extent, which is what coverage ranges over", () => {
    const s = parseChunkStats(body(10, { startTs: 1_752_600_000 }));
    expect(s.firstStrapTs).toBe(1_752_600_000);
    expect(s.lastStrapTs).toBe(1_752_600_009);
  });

  it("counts inline decoded IMU summaries", () => {
    expect(parseChunkStats(body(4, { imu: true })).nImu).toBe(4);
    expect(parseChunkStats(body(4, { imu: false })).nImu).toBe(0);
  });

  it("counts a bad line instead of throwing away the whole chunk", () => {
    // A 16 MB chunk holds thousands of good buffers; refusing all of them to punish one malformed
    // line would discard research data that no longer exists anywhere else.
    const b = Buffer.concat([body(2), Buffer.from("{not json\n"), body(1, { startTs: 1_752_600_050 })]);
    const s = parseChunkStats(b);
    expect(s.lines).toBe(3);
    expect(s.badLines).toBe(1);
  });

  it("treats a null strap_ts as expected, not corrupt", () => {
    // The capture path emits literal null when the frame was too short to carry offset-15's stamp.
    const s = parseChunkStats(Buffer.from(`{"ts_ms":1752600000000,"strap_ts":null,"size":1244}\n`));
    expect(s.lines).toBe(1);
    expect(s.firstStrapTs).toBeNull();
  });
});

describe("parseChunkHeaders", () => {
  it("accepts the generation shape the phone mints", () => {
    expect(parseChunkHeaders({ generation: "1752600000123-45678", byteStart: "0", byteEnd: "100", compression: "deflate-raw" }))
      .toEqual({ generation: "1752600000123-45678", byteStart: 0, byteEnd: 100 });
  });

  it("rejects a generation that could escape the object key namespace", () => {
    // The generation lands directly in an object key, so it is validated to the exact minted shape
    // rather than merely escaped.
    for (const generation of ["../../etc/passwd", "a/b", "1752600000123-45678/../x", "", "'; DROP TABLE--"]) {
      expect(() => parseChunkHeaders({ generation, byteStart: "0", byteEnd: "10", compression: "deflate-raw" }))
        .toThrow(DeepBufError);
    }
  });

  it("rejects a compression it does not actually implement", () => {
    // Guessing at the format is how you silently corrupt an archive. gzip/zlib/identity all refused.
    for (const compression of ["gzip", "zlib", "identity", undefined, "deflate"]) {
      expect(() => parseChunkHeaders({ generation: "1-2", byteStart: "0", byteEnd: "10", compression }))
        .toThrow(DeepBufError);
    }
  });

  it("rejects a non-advancing or negative byte range", () => {
    expect(() => parseChunkHeaders({ generation: "1-2", byteStart: "10", byteEnd: "10", compression: "deflate-raw" })).toThrow(DeepBufError);
    expect(() => parseChunkHeaders({ generation: "1-2", byteStart: "10", byteEnd: "5", compression: "deflate-raw" })).toThrow(DeepBufError);
    expect(() => parseChunkHeaders({ generation: "1-2", byteStart: "-1", byteEnd: "5", compression: "deflate-raw" })).toThrow(DeepBufError);
  });
});

describe("chunkKey", () => {
  it("zero-pads so a plain bucket listing is also byte order", () => {
    // The archive must stay reassemblable with nothing but `aws s3 ls`, independent of this server's DB.
    const keys = [chunkKey("g", 16_777_216), chunkKey("g", 0), chunkKey("g", 1024)];
    expect([...keys].sort()).toEqual([chunkKey("g", 0), chunkKey("g", 1024), chunkKey("g", 16_777_216)]);
  });
});

describe("ingestDeepBufferChunk", () => {
  it("stores the compressed object and records a manifest row", async () => {
    const raw = body(5);
    const r = await ingestDeepBufferChunk(deflate(raw), headers("1752600000000-99", 0, raw.length), cfg(), store());
    expect(r.ok).toBe(true);
    expect(r.lines).toBe(5);
    expect(r.rawBytes).toBe(raw.length);
    expect(fs.existsSync(path.join(objDir, r.objectKey))).toBe(true);

    const db = new Database(cfg().serverDbPath, { readonly: true });
    const row = db.prepare("SELECT * FROM deepBufferChunk").get() as any;
    db.close();
    expect(row.generation).toBe("1752600000000-99");
    expect(row.n1244).toBe(5);
    expect(row.firstStrapTs).toBe(1_752_600_000);
    expect(row.lastStrapTs).toBe(1_752_600_004);
  });

  it("stores the compressed bytes VERBATIM, never re-encoded", async () => {
    // The phone already paid for the deflate and the ratio is the point; re-encoding server-side would
    // risk the archive's byte fidelity for nothing.
    const raw = body(5);
    const sent = deflate(raw);
    const r = await ingestDeepBufferChunk(sent, headers("1752600000000-99", 0, raw.length), cfg(), store());
    expect(fs.readFileSync(path.join(objDir, r.objectKey))).toEqual(sent);
  });

  it("is idempotent on (generation, byteStart) — an at-least-once retry is a no-op", async () => {
    // Exactly the phone's watermark unit: a 2xx lost in flight makes it re-send the same range.
    const raw = body(5);
    const h = headers("1752600000000-99", 0, raw.length);
    const first = await ingestDeepBufferChunk(deflate(raw), h, cfg(), store());
    expect(first.duplicate).toBeUndefined();
    const second = await ingestDeepBufferChunk(deflate(raw), h, cfg(), store());
    expect(second.duplicate).toBe(true);
    expect(second.lines).toBe(first.lines);

    const db = new Database(cfg().serverDbPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM deepBufferChunk").get() as any).c).toBe(1);
    db.close();
  });

  it("keeps successive ranges of one generation as distinct rows", async () => {
    const a = body(3), b = body(3, { startTs: 1_752_600_100 });
    await ingestDeepBufferChunk(deflate(a), headers("g-1", 0, a.length), cfg(), store());
    await ingestDeepBufferChunk(deflate(b), headers("g-1", a.length, a.length + b.length), cfg(), store());
    const db = new Database(cfg().serverDbPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM deepBufferChunk").get() as any).c).toBe(2);
    db.close();
  });

  it("rejects a length mismatch between the inflated bytes and the declared range", async () => {
    // A real integrity check on the wire: the phone cuts every chunk at a line boundary, so the
    // inflated length must equal byteEnd - byteStart exactly.
    const raw = body(5);
    await expect(ingestDeepBufferChunk(deflate(raw), headers("g-1", 0, raw.length + 10), cfg(), store()))
      .rejects.toThrow(DeepBufError);
  });

  it("rejects a body that is not raw DEFLATE", async () => {
    await expect(ingestDeepBufferChunk(Buffer.from("plain text"), headers("g-1", 0, 10), cfg(), store()))
      .rejects.toMatchObject({ code: "bad_deflate" });
    // zlib-WRAPPED deflate must also be refused — that is precisely the mistake this contract exists
    // to prevent, and it must fail loudly rather than be guessed at.
    const raw = body(2);
    await expect(ingestDeepBufferChunk(zlib.deflateSync(raw), headers("g-1", 0, raw.length), cfg(), store()))
      .rejects.toMatchObject({ code: "bad_deflate" });
  });

  it("refuses an empty body", async () => {
    await expect(ingestDeepBufferChunk(Buffer.alloc(0), headers("g-1", 0, 10), cfg(), store()))
      .rejects.toMatchObject({ code: "empty_body" });
  });

  it("refuses an oversized compressed body", async () => {
    const c = cfg(); c.maxDeepbufBytes = 10;
    await expect(ingestDeepBufferChunk(Buffer.alloc(100), headers("g-1", 0, 10), c, store()))
      .rejects.toMatchObject({ code: "too_large" });
  });

  it("survives a zip bomb instead of allocating until the machine dies", async () => {
    // DEFLATE's ratio is unbounded, so a few KB can inflate to gigabytes. inflateRaw's maxOutputLength
    // enforces the ceiling DURING inflation rather than after.
    const bomb = zlib.deflateRawSync(Buffer.alloc(50_000_000, 0x61)); // 50 MB of 'a' -> ~48 KB
    const c = cfg(); c.maxDeepbufRawBytes = 1_000_000;
    await expect(ingestDeepBufferChunk(bomb, headers("g-1", 0, 50_000_000), c, store()))
      .rejects.toMatchObject({ code: "too_large" });
  });

  it("does not leave a manifest row when the object store put fails", async () => {
    // Bucket first, THEN the DB: the reverse order would let the manifest reference an object that
    // does not exist — a hole no retry heals, because the phone believes that range is done.
    const failing = { kind: "x", put: async () => { throw new Error("bucket down"); }, get: async () => Buffer.alloc(0), head: async () => null, signedUrl: async () => null };
    const raw = body(3);
    await expect(ingestDeepBufferChunk(deflate(raw), headers("g-1", 0, raw.length), cfg(), failing as any)).rejects.toThrow();
    const db = new Database(cfg().serverDbPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM deepBufferChunk").get() as any).c).toBe(0);
    db.close();
  });
});

describe("the Swift <-> Node compression contract", () => {
  // THE CROSS-LANGUAGE PIN. Apple's Compression framework calls this algorithm `.zlib`, but
  // COMPRESSION_ZLIB emits a RAW DEFLATE stream with no zlib header and no Adler-32 trailer — so the
  // server must use inflateRaw, not inflate. Getting this wrong fails at RUNTIME on both sides and at
  // compile time on neither. These bytes are not synthesised here: they were produced by running
  // `(data as NSData).compressed(using: .zlib)` — the exact call in DeepBufferUploader.deflate — on
  // macOS with Swift, then base64'd. This is the only test in either repo that proves the two halves
  // of the wire agree.
  const SWIFT_DEFLATED_B64 = "5c89CgIxEAXg3mNMnUBmiHHIZZbJHysoK0kEcfHuprAR2VrQme6913wr9DadG3g87MmZ1ylovcpl6m/FSI/3PBKyVsFSymmRBL7Xa1YQZ6ngwaHhMSXNySXNFFg7tKIxcgymcIrRgYI538ZYwncfHrv1w49bfvwPP2356Rf9Tw==";
  const SWIFT_RAW_LEN = 768;

  it("Node inflates bytes produced by Apple's Compression framework", () => {
    const raw = zlib.inflateRawSync(Buffer.from(SWIFT_DEFLATED_B64, "base64"));
    expect(raw.length).toBe(SWIFT_RAW_LEN);
    const lines = raw.toString("utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).strap_ts).toBe(1_752_600_000);
  });

  it("plain inflate FAILS on them — proving the stream really is headerless raw DEFLATE", () => {
    // If Apple ever started emitting a zlib header this would start passing, and the guard above would
    // start failing — either way the contract change is caught here rather than in production.
    expect(() => zlib.inflateSync(Buffer.from(SWIFT_DEFLATED_B64, "base64"))).toThrow();
  });

  it("real Swift-produced bytes flow through the full ingest path", async () => {
    const compressed = Buffer.from(SWIFT_DEFLATED_B64, "base64");
    const r = await ingestDeepBufferChunk(compressed, headers("1752600000123-4242", 0, SWIFT_RAW_LEN), cfg(), store());
    expect(r.ok).toBe(true);
    expect(r.lines).toBe(3);
    expect(r.rawBytes).toBe(SWIFT_RAW_LEN);
  });
});
