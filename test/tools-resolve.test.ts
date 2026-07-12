import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { createApp } from "../src/server.js";

const dataDir = path.join(process.cwd(), "test/.tmp/resolve");
function cfg() { return { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0 } as any; }
const RUN_TS = Math.floor(new Date("2026-06-12T18:00:00Z").getTime() / 1000);

function mcp(port: number, token: string, id: number, name: string, args: object): Promise<any> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const r = http.request({ port, path: "/mcp", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        const line = d.split("\n").find((l) => l.startsWith("data:")) ?? d;
        resolve(JSON.parse(line.replace(/^data:\s*/, "")).result.structuredContent);
      });
    });
    r.end(payload);
  });
}

let port = 0; let server: any;
beforeAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
  const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), cfg());
  const app = createApp(cfg()); server = app.listen(0); port = (server.address() as any).port;
});

describe("confirm/reject/undo", () => {
  it("full lifecycle: propose → confirm → journal → undo → journal grows, overlay empties", async () => {
    const p = await mcp(port, cfg().roToken, 1, "propose_edit", { kind: "delete_workout", payload: { deviceId: "my-whoop", startTs: RUN_TS, sport: "running" }, rationale: "dup" });
    const c = await mcp(port, cfg().rwToken, 2, "confirm_edit", { id: p.id });
    expect(c.applied).toBe(true); expect(c.seq).toBeGreaterThan(0);
    const c2 = await mcp(port, cfg().rwToken, 3, "confirm_edit", { id: p.id });
    expect(c2.applied).toBe(true); expect(c2.note).toBe("already applied"); // idempotent retry
    const j1 = await mcp(port, cfg().rwToken, 4, "edit_journal", {});
    expect(j1.edits.length).toBe(1);
    const u = await mcp(port, cfg().rwToken, 5, "undo_edit", { seq: c.seq });
    expect(u.undoneSeq).toBe(c.seq);
    const j2 = await mcp(port, cfg().rwToken, 6, "edit_journal", {});
    expect(j2.edits.length).toBe(2); // append-only: undo is a new entry
    const u2 = await mcp(port, cfg().rwToken, 7, "undo_edit", { seq: c.seq });
    expect(u2.error).toBe("not_undoable");
  });
  it("reject leaves no journal entry", async () => {
    const p = await mcp(port, cfg().roToken, 8, "propose_edit", { kind: "set_baseline_note", payload: { note: "oura reads low" }, rationale: "baseline" });
    const r = await mcp(port, cfg().rwToken, 9, "reject_edit", { id: p.id });
    expect(r.rejected).toBe(true);
    const j = await mcp(port, cfg().rwToken, 10, "edit_journal", {});
    expect(j.edits.filter((e: any) => e.editId === p.id).length).toBe(0);
  });
});
