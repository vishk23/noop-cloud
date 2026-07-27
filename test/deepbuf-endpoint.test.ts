import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http"; import zlib from "node:zlib";
import { createApp } from "../src/server.js";

const dataDir = path.join(process.cwd(), "test/.tmp/deepbuf-endpoint");
const objDir = path.join(dataDir, "objects");
const base = () => ({
  dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"),
  maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0,
  maxDeepbufBytes: 25_165_824, maxDeepbufRawBytes: 67_108_864, s3Region: "auto",
} as any);
const cfg = () => ({ ...base(), deepbufFsDir: objDir });
const cfgNoStorage = () => base();

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(objDir, { recursive: true });
});

function rawBody(n: number, startTs = 1_752_600_000) {
  let s = "";
  for (let i = 0; i < n; i++) s += `{"ts_ms":${(startTs + i) * 1000},"strap_ts":${startTs + i},"size":1244,"offload":true,"char":"6108","hex":"${"ab".repeat(64)}"}\n`;
  return Buffer.from(s, "utf8");
}

function post(port: number, headers: Record<string, string>, body: Buffer): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const r = http.request({ port, path: "/deepbuf", method: "POST", headers: { "content-type": "application/octet-stream", ...headers } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode!, json: d ? JSON.parse(d) : null }));
    });
    r.end(body);
  });
}

/** The exact header set DeepBufferUploader/CloudSyncClient sends. */
const chunkHeaders = (token: string, generation: string, byteStart: number, byteEnd: number) => ({
  authorization: `Bearer ${token}`,
  "x-deepbuf-compression": "deflate-raw",
  "x-deepbuf-generation": generation,
  "x-deepbuf-byte-start": String(byteStart),
  "x-deepbuf-byte-end": String(byteEnd),
  "x-phone-timezone": "America/Los_Angeles",
});

async function withApp<T>(c: any, fn: (port: number) => Promise<T>): Promise<T> {
  const s = createApp(c).listen(0);
  try { return await fn((s.address() as any).port); } finally { s.close(); }
}

describe("POST /deepbuf", () => {
  it("requires the rw scope — ro and anonymous are both refused", async () => {
    const raw = rawBody(2), body = zlib.deflateRawSync(raw);
    await withApp(cfg(), async (port) => {
      const anon = await post(port, { "x-deepbuf-compression": "deflate-raw", "x-deepbuf-generation": "1-2", "x-deepbuf-byte-start": "0", "x-deepbuf-byte-end": String(raw.length) }, body);
      expect(anon.status).toBe(401);
      const ro = await post(port, chunkHeaders(cfg().roToken, "1-2", 0, raw.length), body);
      expect(ro.status).toBe(401);
    });
  });

  it("accepts a chunk and reports what it stored", async () => {
    const raw = rawBody(5), body = zlib.deflateRawSync(raw);
    await withApp(cfg(), async (port) => {
      const r = await post(port, chunkHeaders(cfg().rwToken, "1752600000000-77", 0, raw.length), body);
      expect(r.status).toBe(200);
      expect(r.json.ok).toBe(true);
      expect(r.json.lines).toBe(5);
      expect(r.json.rawBytes).toBe(raw.length);
      expect(r.json.storedBytes).toBe(body.length);
      expect(fs.existsSync(path.join(objDir, r.json.objectKey))).toBe(true);
    });
  });

  it("is idempotent — the phone's retry of a confirmed range is a no-op", async () => {
    const raw = rawBody(5), body = zlib.deflateRawSync(raw);
    await withApp(cfg(), async (port) => {
      const h = chunkHeaders(cfg().rwToken, "1752600000000-77", 0, raw.length);
      expect((await post(port, h, body)).json.duplicate).toBeUndefined();
      const again = await post(port, h, body);
      expect(again.status).toBe(200);
      expect(again.json.duplicate).toBe(true);
    });
  });

  it("returns 503 — never a Fly-volume fallback — when bulk storage is unconfigured", async () => {
    // ~600 MB/day of archive against ~547 MB free would take the whole server down. An operator who
    // forgets an env var must get a loud, immediate refusal, not a full disk two days later.
    const raw = rawBody(2), body = zlib.deflateRawSync(raw);
    await withApp(cfgNoStorage(), async (port) => {
      const r = await post(port, chunkHeaders(base().rwToken, "1-2", 0, raw.length), body);
      expect(r.status).toBe(503);
      expect(r.json.error).toBe("storage_not_configured");
      // And it says WHICH KIND of "no" this is. The phone renders a non-2xx as the raw body, so a
      // bare code made a deliberately-disabled optional feature read like the whole-DB upload being
      // broken — which is exactly how it read next to the real /ingest failure on 2026-07-26.
      expect(r.json.configured).toBe(false);
      expect(r.json.feature).toBe("deepbuf");
      expect(r.json.detail).toMatch(/not a failure/i);
      expect(r.json.detail).toMatch(/\/ingest/); // names the path that still works
      // And nothing was written to the data dir as a consolation prize.
      expect(fs.existsSync(path.join(dataDir, "deepbuf"))).toBe(false);
    });
  });

  it("rejects malformed headers with a typed 400", async () => {
    const raw = rawBody(2), body = zlib.deflateRawSync(raw);
    await withApp(cfg(), async (port) => {
      const t = cfg().rwToken;
      const bad = [
        [{ ...chunkHeaders(t, "../escape", 0, raw.length) }, "bad_generation"],
        [{ ...chunkHeaders(t, "1-2", 0, raw.length), "x-deepbuf-compression": "gzip" }, "bad_compression"],
        [{ ...chunkHeaders(t, "1-2", 0, raw.length), "x-deepbuf-byte-end": "0" }, "bad_byte_end"],
      ] as const;
      for (const [headers, code] of bad) {
        const r = await post(port, headers as any, body);
        expect(r.status).toBe(400);
        expect(r.json.error).toBe(code);
      }
    });
  });

  it("rejects a body whose inflated length contradicts the declared range", async () => {
    const raw = rawBody(5), body = zlib.deflateRawSync(raw);
    await withApp(cfg(), async (port) => {
      const r = await post(port, chunkHeaders(cfg().rwToken, "1-2", 0, raw.length + 99), body);
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("length_mismatch");
    });
  });
});
