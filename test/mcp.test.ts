import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { createApp } from "../src/server.js";

const dataDir = path.join(process.cwd(), "test/.tmp/mcp");
function cfg() { return { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0 } as any; }

function mcpCall(port: number, token: string, body: object): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const r = http.request({ port, path: "/mcp", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        // Streamable HTTP may reply as SSE (`data: {json}`) or plain JSON.
        const line = d.split("\n").find((l) => l.startsWith("data:")) ?? d;
        const txt = line.replace(/^data:\s*/, "");
        resolve({ status: res.statusCode!, json: txt ? JSON.parse(txt) : null });
      });
    });
    r.end(payload);
  });
}

describe("/mcp", () => {
  it("401 without ro token", async () => {
    fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
    const zip = path.join(dataDir, "b.noopbak"); buildNoopbak(zip); ingestNoopbak(fs.readFileSync(zip), cfg());
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const { status } = await mcpCall(port, "wrong", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    server.close(); expect(status).toBe(401);
  });
  it("lists registered tools", async () => {
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const { json } = await mcpCall(port, cfg().roToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    server.close();
    const names = (json.result?.tools ?? []).map((t: any) => t.name);
    expect(names).toContain("data_freshness");
    expect(names).toContain("health_snapshot");
  });
});
