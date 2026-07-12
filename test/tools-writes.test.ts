import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { createApp } from "../src/server.js";

const dataDir = path.join(process.cwd(), "test/.tmp/writes");
function cfg() { return { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0 } as any; }
const RUN_TS = Math.floor(new Date("2026-06-12T18:00:00Z").getTime() / 1000);

function mcp(port: number, token: string, body: object): Promise<any> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const r = http.request({ port, path: "/mcp", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        const line = d.split("\n").find((l) => l.startsWith("data:")) ?? d;
        resolve(JSON.parse(line.replace(/^data:\s*/, "")));
      });
    });
    r.end(payload);
  });
}

beforeAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), cfg()); });

describe("write tools + scope", () => {
  it("ro caller sees propose/list/journal but NOT confirm/reject/undo (rw-only tools land in Task 5)", async () => {
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const ro = await mcp(port, cfg().roToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const rw = await mcp(port, cfg().rwToken, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    server.close();
    const roNames = ro.result.tools.map((t: any) => t.name);
    const rwNames = rw.result.tools.map((t: any) => t.name);
    expect(roNames).toContain("propose_edit");
    expect(roNames).not.toContain("confirm_edit");
    // rw implies ro: the always-on tools stay visible to a read-write caller too.
    expect(rwNames).toContain("propose_edit");
    // confirm_edit/reject_edit/undo_edit are registered by registerResolutionTools, which
    // Task 4 leaves as a deliberate no-op seam (see the plan's Task 4/5 split) — Task 5's
    // test/tools-resolve.test.ts is where rw-visibility of those three is verified.
  });
  it("propose_edit validates, snapshots, and stages; list_pending shows it", async () => {
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const p = await mcp(port, cfg().roToken, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "propose_edit", arguments: { kind: "delete_workout", payload: { deviceId: "my-whoop", startTs: RUN_TS, sport: "running" }, rationale: "test dup" } } });
    const out = p.result.structuredContent;
    expect(out.status).toBe("pending");
    expect(out.diff).toContain("running");
    const l = await mcp(port, cfg().roToken, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_pending", arguments: {} } });
    server.close();
    expect(l.result.structuredContent.pending.map((x: any) => x.id)).toContain(out.id);
  });
  it("propose_edit on a missing target returns a structured error", async () => {
    const app = createApp(cfg()); const server = app.listen(0); const port = (server.address() as any).port;
    const p = await mcp(port, cfg().roToken, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "propose_edit", arguments: { kind: "delete_workout", payload: { deviceId: "my-whoop", startTs: 1, sport: "ghost" }, rationale: "no match" } } });
    server.close();
    expect(p.result.structuredContent.error).toBe("target_not_found");
  });
});
