import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import { appendJournal, journalSince } from "../src/staging.js";
import { createApp } from "../src/server.js";

const dataDir = path.join(process.cwd(), "test/.tmp/edits-ack");
function cfg() { return { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0 } as any; }
function post(port: number, token: string, body: object): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const r = http.request({ port, path: "/edits/ack", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode!, json: d ? JSON.parse(d) : null }));
    });
    r.end(payload);
  });
}
beforeAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
  appendJournal(cfg(), { editId: "a1", kind: "set_baseline_note", payloadJSON: "{}", beforeJSON: null, rationale: null });
  appendJournal(cfg(), { editId: "a2", kind: "set_baseline_note", payloadJSON: "{}", beforeJSON: null, rationale: null });
});
describe("POST /edits/ack", () => {
  it("requires rw (ro → 401)", async () => {
    const app = createApp(cfg()); const s = app.listen(0); const port = (s.address() as any).port;
    expect((await post(port, cfg().roToken, { seqs: [1] })).status).toBe(401); s.close();
  });
  it("acks rows once and exposes ackedAt via GET /edits", async () => {
    const app = createApp(cfg()); const s = app.listen(0); const port = (s.address() as any).port;
    const r1 = await post(port, cfg().rwToken, { seqs: [1, 2] });
    expect(r1.json.acked).toBe(2);
    const r2 = await post(port, cfg().rwToken, { seqs: [1, 2] });
    expect(r2.json.acked).toBe(0); // already acked
    s.close();
    const rows = journalSince(cfg(), 0);
    expect(rows.every((e: any) => e.ackedAt !== null)).toBe(true);
  });
  it("400 on garbage", async () => {
    const app = createApp(cfg()); const s = app.listen(0); const port = (s.address() as any).port;
    expect((await post(port, cfg().rwToken, { seqs: "x" })).status).toBe(400); s.close();
  });
});
