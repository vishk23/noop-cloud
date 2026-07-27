import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { createApp } from "../src/server.js";

const dataDir = path.join(process.cwd(), "test/.tmp/mcp-urlsecret");
const SECRET = "s".padEnd(48, "z");
function cfg() {
  return {
    dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"),
    maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"),
    mcpUrlSecret: SECRET, port: 0,
  } as any;
}

// POST /mcp/<path secret> with NO Authorization header, mirroring how ChatGPT's "No Auth" connector calls.
function urlSecretCall(port: number, secret: string, body: object): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const r = http.request({ port, path: `/mcp/${secret}`, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        const line = d.split("\n").find((l) => l.startsWith("data:")) ?? d;
        const txt = line.replace(/^data:\s*/, "");
        resolve({ status: res.statusCode!, json: txt ? JSON.parse(txt) : null });
      });
    });
    r.end(payload);
  });
}

describe("/mcp/:secret (no-auth URL secret)", () => {
  it("serves the strict public read-only surface with the correct URL secret and no bearer", async () => {
    fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
    const zip = path.join(dataDir, "b.noopbak"); buildNoopbak(zip); await ingestNoopbak(fs.readFileSync(zip), cfg());
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const { status, json } = await urlSecretCall(port, SECRET, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (json?.result?.tools ?? []).map((t: any) => t.name);
    server.close();
    expect(status).toBe(200);
    // Pure reads are present...
    expect(names).toContain("data_freshness");
    expect(names).toContain("hr_series");
    expect(names).toContain("search");
    // ...but NO write-proposal, edit-resolution, or phone-poking tools reach an anonymous URL caller.
    for (const forbidden of ["propose_edit", "list_pending", "edit_journal", "confirm_edit", "reject_edit", "undo_edit", "request_sync"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("405s (not 404) on GET with the correct secret, so a probing connector sees method-not-supported", async () => {
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const status: number = await new Promise((resolve) => {
      const r = http.request({ port, path: `/mcp/${SECRET}`, method: "GET", headers: { accept: "text/event-stream" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      r.end();
    });
    server.close();
    expect(status).toBe(405);
  });

  it("404s on a wrong URL secret", async () => {
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const { status } = await urlSecretCall(port, "wrong-secret", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    server.close();
    expect(status).toBe(404);
  });

  it("404s when no MCP_URL_SECRET is configured", async () => {
    const noSecret = { ...cfg(), mcpUrlSecret: undefined };
    const app = createApp(noSecret); const server = app.listen(0); const port = (server.address() as any).port;
    const { status } = await urlSecretCall(port, SECRET, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    server.close();
    expect(status).toBe(404);
  });
});
