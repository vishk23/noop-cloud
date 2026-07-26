import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import { ingestDeepBufferChunk } from "../src/deepbuf.js";
import { FsObjectStore } from "../src/objectstore.js";
import { deepBufferCoverage, deepBufferWindow } from "../src/tools/deepbuf.js";

const dataDir = path.join(process.cwd(), "test/.tmp/tools-deepbuf");
const objDir = path.join(dataDir, "objects");
const cfg = () => ({
  serverDbPath: path.join(dataDir, "server.sqlite"),
  maxDeepbufBytes: 25_165_824,
  maxDeepbufRawBytes: 67_108_864,
  deepbufFsDir: objDir,
} as any);
/** Same config with NO storage backend at all — the unconfigured-server case. */
const cfgUnconfigured = () => ({ ...cfg(), deepbufFsDir: undefined });

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(objDir, { recursive: true });
});

function body(n: number, opts: { startTs?: number; size?: number; imu?: boolean } = {}) {
  const { startTs = 1_752_600_000, size = 1244, imu = false } = opts;
  let s = "";
  for (let i = 0; i < n; i++) {
    const imuField = imu ? `,"imu":{"sampleCount":100,"accelEnergyG":0.12,"cadenceHz":1.7}` : "";
    s += `{"ts_ms":${(startTs + i) * 1000},"strap_ts":${startTs + i},"size":${size},"offload":true,"char":"6108","hex":"${"ab".repeat(64)}"${imuField}}\n`;
  }
  return Buffer.from(s, "utf8");
}

let cursor = 0;
/** Push one chunk through the real ingest path so the manifest + objects are genuinely populated. */
async function seed(raw: Buffer, generation = "1752600000000-11") {
  const r = await ingestDeepBufferChunk(zlib.deflateRawSync(raw), { generation, byteStart: cursor, byteEnd: cursor + raw.length }, cfg(), new FsObjectStore(objDir));
  cursor += raw.length;
  return r;
}
beforeEach(() => { cursor = 0; });

describe("deep_buffer_coverage", () => {
  it("distinguishes 'storage unconfigured' from 'nothing uploaded yet'", () => {
    // Two very different problems that both look like "no data". Conflating them would send VK
    // debugging his strap when the actual fault is an unset env var (uploads 503-ing).
    const unconfigured = deepBufferCoverage(cfgUnconfigured(), {}) as any;
    expect(unconfigured.notCaptured).toBe(true);
    expect(unconfigured.configured).toBe(false);
    expect(unconfigured.hint).toMatch(/not configured/i);

    const configured = deepBufferCoverage(cfg(), {}) as any;
    expect(configured.notCaptured).toBe(true);
    expect(configured.configured).toBe(true);
    expect(configured.hint).toMatch(/has not drained|capture toggle/i);
  });

  it("reports a capture run with the two buffer families counted separately", async () => {
    // The strap banks ONE 1244-B and ONE 2140-B buffer per second, so a complete 10-second run has
    // 10 of each. Separate counts are the diagnostic — a blended ratio would hide which one is short.
    await seed(body(10, { size: 1244, startTs: 1_752_600_000 }));
    await seed(body(10, { size: 2140, startTs: 1_752_600_000 }));
    const r = deepBufferCoverage(cfg(), {}) as any;
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].imuBuffers).toBe(10);
    expect(r.sessions[0].opticalBuffers).toBe(10);
    expect(r.sessions[0].expectedPerKind).toBe(10);
    expect(r.totals.buffers).toBe(20);
  });

  it("makes a missing optical half visible", async () => {
    await seed(body(10, { size: 1244, startTs: 1_752_600_000 }));
    const r = deepBufferCoverage(cfg(), {}) as any;
    expect(r.sessions[0].imuBuffers).toBe(10);
    expect(r.sessions[0].opticalBuffers).toBe(0);
    expect(r.sessions[0].expectedPerKind).toBe(10);
  });

  it("splits runs on a gap rather than bridging an invented hole", async () => {
    await seed(body(5, { startTs: 1_752_600_000 }));
    await seed(body(5, { startTs: 1_752_700_000 })); // ~28h later
    const r = deepBufferCoverage(cfg(), {}) as any;
    expect(r.sessions).toHaveLength(2);
    expect(r.totals.sessions).toBe(2);
  });

  it("honours gapSeconds", async () => {
    await seed(body(5, { startTs: 1_752_600_000 }));   // ends ...004
    await seed(body(5, { startTs: 1_752_600_100 }));   // 96s gap
    expect((deepBufferCoverage(cfg(), {}) as any).sessions).toHaveLength(2);        // default 60s -> split
    expect((deepBufferCoverage(cfg(), { gapSeconds: 3600 }) as any).sessions).toHaveLength(1); // bridged
  });

  it("reports the compression ratio actually achieved", async () => {
    const raw = body(20);
    await seed(raw);
    const r = deepBufferCoverage(cfg(), {}) as any;
    expect(r.totals.rawBytes).toBe(raw.length);
    expect(r.totals.storedBytes).toBeLessThan(raw.length);
    expect(r.totals.compressionRatio).toBeGreaterThan(1);
  });

  it("counts inline decoded IMU summaries", async () => {
    await seed(body(6, { imu: true }));
    expect((deepBufferCoverage(cfg(), {}) as any).sessions[0].decodedImuBuffers).toBe(6);
  });

  it("anchors on the archive's own extent when no window is given", async () => {
    await seed(body(5, { startTs: 1_752_600_000 }));
    const r = deepBufferCoverage(cfg(), {}) as any;
    expect(r.dataExtent.firstStrapTs).toBe(1_752_600_000);
    expect(r.dataExtent.lastStrapTs).toBe(1_752_600_004);
  });

  it("points at dataExtent when the range is empty but the archive is not", async () => {
    await seed(body(5, { startTs: 1_752_600_000 }));
    const r = deepBufferCoverage(cfg(), { from: "2020-01-01", to: "2020-01-02" }) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.dataExtent.firstStrapTs).toBe(1_752_600_000);
    expect(r.hint).toMatch(/elsewhere/i);
  });

  it("refuses an absurd span rather than scanning a year of manifest", async () => {
    await seed(body(2));
    expect((deepBufferCoverage(cfg(), { from: "2000-01-01", to: "2026-01-01" }) as any).error).toBe("span_too_wide");
  });

  it("includes a chunk that straddles the window boundary", async () => {
    // Overlap, not containment — a chunk starting BEFORE the window and ending inside it still holds
    // buffers the caller asked for. A containment query would silently drop the whole chunk.
    const chunkStart = 1_752_599_800, chunkEnd = 1_752_600_399;
    await seed(body(600, { startTs: chunkStart }));
    const r = deepBufferCoverage(cfg(), {
      from: new Date(1_752_600_000 * 1000).toISOString(), // after the chunk starts
      to: new Date(1_752_600_100 * 1000).toISOString(),   // before the chunk ends
    }) as any;
    expect(r.error).toBeUndefined();
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].startTs).toBe(chunkStart);
    expect(r.sessions[0].endTs).toBe(chunkEnd);
  });
});

describe("deep_buffer_window", () => {
  const iso = (t: number) => new Date(t * 1000).toISOString();

  it("returns metadata and NO hex by default", async () => {
    // The central constraint: one 2140-B buffer is ~4.3 KB of hex, so an hour is ~24 MB. An MCP tool
    // must never be a route to stream that.
    await seed(body(5, { imu: true }));
    const r = await deepBufferWindow(cfg(), { from: iso(1_752_600_000), to: iso(1_752_600_004) }) as any;
    expect(r.buffers).toHaveLength(5);
    expect(r.buffers[0].hex).toBeUndefined();
    expect(r.buffers[0].strapTs).toBe(1_752_600_000);
    expect(r.buffers[0].kind).toBe("imu-6axis-100hz");
    expect(r.buffers[0].imu).toMatchObject({ cadenceHz: 1.7 });
    // Without hex, each buffer still carries a handle to where its bytes live.
    expect(r.buffers[0].objectKey).toBeTruthy();
  });

  it("labels the undecoded optical buffer for what it is", async () => {
    await seed(body(3, { size: 2140 }));
    const r = await deepBufferWindow(cfg(), { from: iso(1_752_600_000), to: iso(1_752_600_002) }) as any;
    expect(r.buffers[0].kind).toBe("optical-ppg-undecoded");
  });

  it("caps hex at 5 buffers even when more match", async () => {
    await seed(body(50));
    const r = await deepBufferWindow(cfg(), { from: iso(1_752_600_000), to: iso(1_752_600_049), includeHex: true }) as any;
    expect(r.buffers.filter((b: any) => b.hex !== undefined)).toHaveLength(5);
    expect(r.hexCapped).toBe(true);
    expect(r.hexHint).toMatch(/signed URLs/i);
  });

  it("filters to one buffer family — the usual move for the undecoded optical layout", async () => {
    await seed(Buffer.concat([body(4, { size: 1244 }), body(4, { size: 2140, startTs: 1_752_600_010 })]));
    const r = await deepBufferWindow(cfg(), { from: iso(1_752_600_000), to: iso(1_752_600_020), sizes: [2140] }) as any;
    expect(r.buffers).toHaveLength(4);
    expect(r.buffers.every((b: any) => b.size === 2140)).toBe(true);
  });

  it("hands back object handles for out-of-band bulk download", async () => {
    await seed(body(5));
    const r = await deepBufferWindow(cfg(), { from: iso(1_752_600_000), to: iso(1_752_600_004) }) as any;
    expect(r.objects).toHaveLength(1);
    expect(r.objects[0].key).toMatch(/^deepbuf\/v1\//);
    expect(r.objects[0].encoding).toMatch(/raw-deflate/i);
    expect(r.objects[0].rawBytes).toBeGreaterThan(0);
    // FsObjectStore cannot mint URLs; the S3/R2 store does. Null is the honest answer, not an error.
    expect(r.objects[0].url).toBeNull();
  });

  it("truncates loudly rather than silently returning a prefix", async () => {
    await seed(body(100));
    const r = await deepBufferWindow(cfg(), { from: iso(1_752_600_000), to: iso(1_752_600_099), maxBuffers: 10 }) as any;
    expect(r.buffers).toHaveLength(10);
    expect(r.matched).toBe(100);
    expect(r.truncated).toBe(true);
    expect(r.hint).toMatch(/maxBuffers/);
  });

  it("refuses a window too wide to read raw buffers over", async () => {
    const r = await deepBufferWindow(cfg(), { from: "2026-07-01", to: "2026-07-15" }) as any;
    expect(r.error).toBe("span_too_wide");
    expect(r.hint).toMatch(/deep_buffer_coverage/);
  });

  it("says so when storage is unconfigured", async () => {
    const r = await deepBufferWindow(cfgUnconfigured(), { from: iso(1_752_600_000), to: iso(1_752_600_004) }) as any;
    expect(r.configured).toBe(false);
    expect(r.buffers).toEqual([]);
  });

  it("reports an empty window without pretending it is an error", async () => {
    await seed(body(5, { startTs: 1_752_600_000 }));
    const r = await deepBufferWindow(cfg(), { from: iso(1_700_000_000), to: iso(1_700_000_100) }) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.buffers).toEqual([]);
  });

  it("reports a hole rather than failing the whole window when an object is gone", async () => {
    // An orphaned manifest row (a put that landed, a DB row that landed, then a bucket lifecycle rule
    // or manual delete). This is a REAL fact about the archive and must be visible.
    const r0 = await seed(body(5));
    fs.rmSync(path.join(objDir, r0.objectKey));
    const r = await deepBufferWindow(cfg(), { from: iso(1_752_600_000), to: iso(1_752_600_004) }) as any;
    expect(r.failedObjects).toEqual([r0.objectKey]);
    expect(r.failedHint).toMatch(/hole/i);
  });

  it("excludes buffers outside the window even when their chunk overlaps it", async () => {
    await seed(body(100, { startTs: 1_752_600_000 }));
    const r = await deepBufferWindow(cfg(), { from: iso(1_752_600_010), to: iso(1_752_600_019) }) as any;
    expect(r.buffers).toHaveLength(10);
    expect(r.buffers[0].strapTs).toBe(1_752_600_010);
    expect(r.buffers[9].strapTs).toBe(1_752_600_019);
  });
});
