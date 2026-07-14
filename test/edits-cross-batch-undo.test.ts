// Reproduces the 2026-07-14 cross-batch undo bug end-to-end over MCP: an adjust_sleep_bounds edit is
// confirmed, then undone. Before the fix the undo was a phone-side no-op whenever the original had
// been pulled + applied in an EARLIER batch (the phone never re-pulls it, and CloudEditApplier only
// skips the undo marker). The fix appends a forward COMPENSATING edit re-asserting the pre-undo state,
// which every app version applies as a normal edit — so a phone syncing from any cursor reverts.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { createApp } from "../src/server.js";

const dataDir = path.join(process.cwd(), "test/.tmp/cross-batch-undo");
function cfg() { return { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0 } as any; }
const START = Math.floor(new Date("2026-06-12T03:00:00Z").getTime() / 1000); // fixture my-whoop sleep start
const MIRROR_END = START + 25200; // fixture detected end
const MOVED_END = START + 28800; // +1h

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

describe("cross-batch undo of adjust_sleep_bounds", () => {
  it("undo appends a forward compensation carrying the pre-edit end, visible to a cursor PAST the original", async () => {
    const p = await mcp(port, cfg().roToken, 1, "propose_edit", { kind: "adjust_sleep_bounds", payload: { deviceId: "my-whoop", startTs: START, newEndTs: MOVED_END }, rationale: "woke later than detected" });
    const c = await mcp(port, cfg().rwToken, 2, "confirm_edit", { id: p.id });
    expect(c.applied).toBe(true);
    const d1 = await mcp(port, cfg().roToken, 3, "sleep_detail", { deviceId: "my-whoop", startTs: START });
    expect(d1.session.endTs).toBe(MOVED_END);

    const u = await mcp(port, cfg().rwToken, 4, "undo_edit", { seq: c.seq });
    expect(u.undoneSeq).toBe(c.seq);
    expect(u.compensationSeq).toBeGreaterThan(u.bySeq); // a forward row, appended after the undo marker

    // Server read reverts to the detected end (the mirror baseline the compensation re-asserts).
    const d2 = await mcp(port, cfg().roToken, 5, "sleep_detail", { deviceId: "my-whoop", startTs: START });
    expect(d2.session.endTs).toBe(MIRROR_END);

    // The cross-batch guarantee: a phone whose cursor is already PAST the original edit (since=c.seq)
    // still receives the compensation, so it can revert even though it never re-pulls seq c.seq.
    const tail = await mcp(port, cfg().rwToken, 6, "edit_journal", { since: c.seq });
    const comp = tail.edits.find((e: any) => e.seq === u.compensationSeq);
    expect(comp.kind).toBe("adjust_sleep_bounds");
    expect(JSON.parse(comp.payloadJSON)).toMatchObject({ deviceId: "my-whoop", startTs: START, newEndTs: MIRROR_END });
    expect(comp.undoneBySeq).toBeNull(); // active — the phone applies it as a normal edit
  });

  it("undo of an already-undone edit is rejected and appends no second compensation", async () => {
    const p = await mcp(port, cfg().roToken, 10, "propose_edit", { kind: "adjust_sleep_bounds", payload: { deviceId: "my-whoop", startTs: START, newStartTs: START - 600 }, rationale: "fell asleep earlier" });
    const c = await mcp(port, cfg().rwToken, 11, "confirm_edit", { id: p.id });
    const before = await mcp(port, cfg().rwToken, 12, "edit_journal", {});
    const u1 = await mcp(port, cfg().rwToken, 13, "undo_edit", { seq: c.seq });
    expect(u1.compensationSeq).toBeGreaterThan(0);
    const afterFirst = await mcp(port, cfg().rwToken, 14, "edit_journal", {});
    const u2 = await mcp(port, cfg().rwToken, 15, "undo_edit", { seq: c.seq });
    expect(u2.error).toBe("not_undoable");
    const afterSecond = await mcp(port, cfg().rwToken, 16, "edit_journal", {});
    expect(afterFirst.edits.length).toBe(before.edits.length + 2); // undo marker + one compensation
    expect(afterSecond.edits.length).toBe(afterFirst.edits.length); // rejected retry added nothing
  });

  it("undo of a set_baseline_note appends no compensation (phone ignores notes)", async () => {
    const p = await mcp(port, cfg().roToken, 20, "propose_edit", { kind: "set_baseline_note", payload: { note: "oura reads low" }, rationale: "baseline" });
    const c = await mcp(port, cfg().rwToken, 21, "confirm_edit", { id: p.id });
    const u = await mcp(port, cfg().rwToken, 22, "undo_edit", { seq: c.seq });
    expect(u.undoneSeq).toBe(c.seq);
    expect(u.compensationSeq).toBeUndefined();
  });
});
