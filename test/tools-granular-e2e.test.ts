import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { createApp } from "../src/server.js";

const dataDir = path.join(process.cwd(), "test/.tmp/granular-e2e");
function cfg() { return { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0 } as any; }
const NIGHT = Math.floor(new Date("2026-06-13T03:00:00Z").getTime() / 1000);

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
beforeAll(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
  const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), cfg());
  const app = createApp(cfg()); server = app.listen(0); port = (server.address() as any).port;
});

describe("granular edit full loop over MCP", () => {
  it("propose(ro) → confirm(rw) → sleep_detail reflects → undo(rw) → reverts", async () => {
    const stages = [{ start: NIGHT, end: NIGHT + 12600, stage: "deep" }, { start: NIGHT + 12600, end: NIGHT + 25200, stage: "light" }];
    const p = await mcp(port, cfg().roToken, 1, "propose_edit", { kind: "edit_sleep_stages", payload: { deviceId: "my-whoop", startTs: NIGHT, stages }, rationale: "HR shows deep sleep until 6:30, band misread movement" });
    expect(p.status).toBe("pending");
    expect(p.diff).toContain("deep");
    const c = await mcp(port, cfg().rwToken, 2, "confirm_edit", { id: p.id });
    expect(c.applied).toBe(true);
    const d1 = await mcp(port, cfg().roToken, 3, "sleep_detail", { deviceId: "my-whoop", startTs: NIGHT });
    expect(d1.stagesEdited).toBe(true);
    expect(d1.stages.length).toBe(2);
    const u = await mcp(port, cfg().rwToken, 4, "undo_edit", { seq: c.seq });
    expect(u.undoneSeq).toBe(c.seq);
    // Cross-batch heal: undo now ALSO appends a forward compensating edit_sleep_stages re-asserting
    // the pre-edit (mirror) hypnogram, so a phone that applied the original in an earlier batch reverts
    // it. The stage VALUES revert to the fixture's original 4-segment hypnogram; the night reads as
    // edited because that compensation is itself an (authoritative) cloud edit.
    expect(u.compensationSeq).toBeGreaterThan(u.bySeq);
    const d2 = await mcp(port, cfg().roToken, 5, "sleep_detail", { deviceId: "my-whoop", startTs: NIGHT });
    expect(d2.stagesEdited).toBe(true); // annotated with the compensation edit
    expect(d2.stages.length).toBe(4); // reverted to the fixture's original hypnogram
    expect(d2.stages.map((s: any) => s.stage)).toEqual(["light", "deep", "rem", "light"]);
  });
});
