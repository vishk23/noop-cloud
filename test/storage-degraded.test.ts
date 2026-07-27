import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { dataFreshness } from "../src/tools/core.js";
import { buildMcpServer } from "../src/mcp.js";
import { createApp } from "../src/server.js";

// What a client SAW during the 2026-07-26 outage was the four characters of a driver string:
// `disk I/O error`. No layer, no cause, no indication that the server rather than the request was
// broken — and data_freshness, the tool documented as "Call this first", failed identically.

const dataDir = path.join(process.cwd(), "test/.tmp/degraded");
const cfg = () => ({
  dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"),
  maxIngestBytes: 262_144_000, minFreeBytes: 1024, stagedSweepAgeMs: 3_600_000,
  roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0,
} as any);
beforeEach(async () => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

const ingestFixture = async () => { const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), cfg()); };
/** Valid SQLite magic, garbage past the header — SQLite raises SQLITE_NOTADB on first read. */
const breakMirror = () => fs.writeFileSync(cfg().mirrorPath, Buffer.concat([Buffer.from("SQLite format 3\0", "binary"), Buffer.alloc(8192, 0x7f)]));
const plantOrphan = () => {
  const p = path.join(dataDir, ".staged-deadbeefcafe.sqlite");
  fs.writeFileSync(p, Buffer.alloc(4096));
  const old = new Date(Date.now() - 5 * 86_400_000);
  fs.utimesSync(p, old, old);
};

async function connect(server: ReturnType<typeof buildMcpServer>) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe("MCP storage guard", () => {
  it("replaces a bare driver string with an actionable, self-locating message", async () => {
    await ingestFixture();
    breakMirror();
    const client = await connect(buildMcpServer(cfg(), "ro"));
    const res: any = await client.callTool({ name: "health_snapshot", arguments: { days: 3 } });
    const text = res.content[0].text as string;

    expect(res.isError).toBe(true);
    expect(text).not.toBe("disk I/O error");
    expect(text).toMatch(/storage is degraded/i);
    expect(text).toMatch(/not a bad request/i);  // the caller is not at fault
    expect(text).toMatch(/\/status/);            // where to look next
    expect(text.length).toBeGreaterThan(80);     // an explanation, not a code
  });

  it("does NOT swallow ordinary tool failures", async () => {
    // The guard must be surgical: only storage faults get rewritten, everything else keeps its
    // existing behaviour so real bugs stay visible.
    await ingestFixture();
    const server = buildMcpServer(cfg(), "ro");
    server.registerTool("probe_boom", { title: "probe", description: "throws", inputSchema: {} },
      async () => { throw new Error("ordinary failure"); });
    const client = await connect(server);
    const res: any = await client.callTool({ name: "probe_boom", arguments: {} });
    expect(JSON.stringify(res)).toMatch(/ordinary failure/);
    expect(JSON.stringify(res)).not.toMatch(/storage is degraded/i);
  });

  it("keeps healthy tools working normally", async () => {
    await ingestFixture();
    const client = await connect(buildMcpServer(cfg(), "ro"));
    const res: any = await client.callTool({ name: "health_snapshot", arguments: { days: 3 } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).days.length).toBeGreaterThan(0);
  });
});

describe("data_freshness storage diagnostics", () => {
  it("always reports disk, mirror size and last-ingest age", async () => {
    await ingestFixture();
    const r: any = dataFreshness(cfg());
    expect(r.storage).toBeDefined();
    expect(r.storage.disk.totalBytes).toBeGreaterThan(0);
    expect(r.storage.mirror.bytes).toBeGreaterThan(0);
    expect(r.storage.lastIngestAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(r.storage.nextIngestFits).toBe(true);
    expect(r.degraded).toBeUndefined();
  });

  it("surfaces orphaned staging bytes before they become an outage", async () => {
    await ingestFixture();
    plantOrphan();
    const r: any = dataFreshness(cfg());
    expect(r.storage.stagedOrphans.count).toBe(1);
    expect(r.storage.ok).toBe(false);
  });

  it("DEGRADES instead of throwing when the mirror cannot be read", async () => {
    // The whole point: the tool that explains the outage must survive the outage.
    await ingestFixture();
    breakMirror();
    const r: any = dataFreshness(cfg());
    expect(r.degraded).toBe(true);
    expect(r.error).toMatch(/storage is degraded/i);
    expect(r.storage.disk).not.toBeNull();
    expect(r.storage.mirror.exists).toBe(true);
    // Empty because UNREACHABLE, not because absent — `degraded` is what distinguishes the two.
    expect(r.sources).toEqual([]);
    expect(r.notIngested).toBeUndefined();
  });
});

describe("/healthz and /status", () => {
  function get(port: number, p: string, token?: string): Promise<{ status: number; json: any }> {
    return new Promise((resolve) => {
      http.get({ port, path: p, headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
        let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: d ? JSON.parse(d) : null }));
      });
    });
  }

  it("/healthz stays exactly {ok:true} on a healthy server", async () => {
    await ingestFixture();
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const { status, json } = await get(port, "/healthz");
    server.close();
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });
  });

  it("/healthz reports degraded but STILL returns 200", async () => {
    // 200 is deliberate: Fly's health check points here, and a non-2xx would pull the machine from
    // routing — turning "every tool explains the problem" into "the host is unreachable", and
    // blocking the deploy of the fix.
    await ingestFixture();
    plantOrphan();
    const app = createApp({ ...cfg(), stagedSweepAgeMs: Number.MAX_SAFE_INTEGER }); // don't sweep the probe
    const server = app.listen(0); const port = (server.address() as any).port;
    const { status, json } = await get(port, "/healthz");
    server.close();
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.degraded).toBe(true);
    expect(json.warnings.join(" ")).toMatch(/orphaned/);
  });

  it("/healthz goes degraded when the mirror EXISTS but cannot be read", async () => {
    // The gap this closes. Disk is fine, there are no orphans and server.sqlite opens, so every
    // signal /healthz used to look at is green — while every mirror-backed MCP tool is failing.
    // Before probeMirror this returned exactly {ok:true}, which is the 2026-07-26 signature: a green
    // health check through a total serving outage.
    await ingestFixture();
    breakMirror();
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const { status, json } = await get(port, "/healthz");
    server.close();
    expect(status).toBe(200);            // still 200 — routing and deploys must not be blocked
    expect(json.degraded).toBe(true);
    expect(json.warnings.join(" ")).toMatch(/mirror\.sqlite EXISTS but cannot be read/);
  });

  it("a mirror that was never uploaded is NOT degraded", async () => {
    // A fresh server is new, not broken. `fileMustExist` would throw here, so the probe has to be
    // skipped rather than allowed to report the absence as a fault.
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const { status, json } = await get(port, "/healthz");
    server.close();
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });
  });

  it("/status reports mirror.readable", async () => {
    await ingestFixture();
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const { json } = await get(port, "/status", cfg().roToken);
    server.close();
    expect(json.mirror.readable).toBe(true);
  });

  it("data_freshness does NOT pay for the probe", async () => {
    // It opens the mirror itself and has its own `degraded` flag, so probing inside storageReport
    // would open a 766 MB database twice on every call. null = not probed, not "unreadable".
    await ingestFixture();
    const r: any = dataFreshness(cfg());
    expect(r.storage.mirror.readable).toBeNull();
  });

  it("/status requires a token", async () => {
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const { status } = await get(port, "/status");
    server.close();
    expect(status).toBe(401);
  });

  it("/status returns the full storage report", async () => {
    await ingestFixture();
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const { status, json } = await get(port, "/status", cfg().roToken);
    server.close();
    expect(status).toBe(200);
    expect(json.disk.freeBytes).toBeGreaterThan(0);
    expect(json.disk.usedPct).toBeGreaterThanOrEqual(0);
    expect(json.mirror.exists).toBe(true);
    expect(json.stagedOrphans).toEqual({ count: 0, bytes: 0 });
    expect(json.nextIngestFits).toBe(true);
    expect(json.lastIngestAt).toBeTruthy();
  });

  it("createApp sweeps crash corpses at startup", async () => {
    await ingestFixture();
    plantOrphan();
    createApp(cfg()); // constructing the app is what triggers the sweep
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const { json } = await get(port, "/status", cfg().roToken);
    server.close();
    expect(json.stagedOrphans.count).toBe(0);
  });
});
