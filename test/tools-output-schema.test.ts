import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { createApp } from "../src/server.js";

// Exercises the tools that now declare an outputSchema THROUGH the MCP call path, where the SDK runs
// validateToolOutput and throws if structuredContent doesn't match. A direct function call would skip
// that check, so this is the test that proves the loose schemas accept the real (variable) outputs.
const dataDir = path.join(process.cwd(), "test/.tmp/output-schema");
function cfg() { return { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0 } as any; }

function mcpCall(port: number, body: object): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const r = http.request({ port, path: "/mcp", method: "POST", headers: { authorization: `Bearer ${cfg().roToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        const line = d.split("\n").find((l) => l.startsWith("data:")) ?? d;
        const txt = line.replace(/^data:\s*/, "");
        resolve({ status: res.statusCode!, json: txt ? JSON.parse(txt) : null });
      });
    });
    r.end(payload);
  });
}

async function callTool(port: number, name: string, args: object) {
  const { json } = await mcpCall(port, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return json;
}

describe("outputSchema tools validate against real output", () => {
  it("data_freshness, search, and fetch pass output-schema validation with real data", async () => {
    fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
    const zip = path.join(dataDir, "b.noopbak"); buildNoopbak(zip); ingestNoopbak(fs.readFileSync(zip), cfg());
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    try {
      const df = await callTool(port, "data_freshness", {});
      expect(df.error, JSON.stringify(df.error)).toBeUndefined();
      expect(df.result?.isError).toBeFalsy();
      expect(df.result?.structuredContent).toBeTruthy();

      const s = await callTool(port, "search", { query: "" });
      expect(s.error).toBeUndefined();
      expect(s.result?.isError).toBeFalsy();
      const results = s.result?.structuredContent?.results ?? [];
      expect(Array.isArray(results)).toBe(true);

      // fetch a real id if search found one, else a plausible day id — both must pass validation.
      const id = results[0]?.id ?? "day:2026-06-13";
      const f = await callTool(port, "fetch", { id });
      expect(f.error).toBeUndefined();
      expect(f.result?.isError).toBeFalsy();
      expect(typeof f.result?.structuredContent?.text).toBe("string");
    } finally { server.close(); }
  });

  it("data_freshness passes validation on the no-mirror (notIngested) branch", async () => {
    const empty = path.join(process.cwd(), "test/.tmp/output-schema-empty");
    fs.rmSync(empty, { recursive: true, force: true }); fs.mkdirSync(empty, { recursive: true });
    const c = { ...cfg(), dataDir: empty, mirrorPath: path.join(empty, "mirror.sqlite"), serverDbPath: path.join(empty, "server.sqlite") };
    const app = createApp(c); const server = app.listen(0); const port = (server.address() as any).port;
    try {
      const { json } = await new Promise<{ json: any }>((resolve) => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "data_freshness", arguments: {} } });
        const r = http.request({ port, path: "/mcp", method: "POST", headers: { authorization: `Bearer ${c.roToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
          let d = ""; res.on("data", (x) => (d += x)); res.on("end", () => { const line = d.split("\n").find((l) => l.startsWith("data:")) ?? d; resolve({ json: JSON.parse(line.replace(/^data:\s*/, "")) }); });
        });
        r.end(payload);
      });
      expect(json.error).toBeUndefined();
      expect(json.result?.isError).toBeFalsy();
      expect(json.result?.structuredContent?.notIngested).toBe(true);
    } finally { server.close(); }
  });
});
