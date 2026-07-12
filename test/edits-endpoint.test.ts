import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import { appendJournal } from "../src/staging.js";
import { createApp } from "../src/server.js";

const dataDir = path.join(process.cwd(), "test/.tmp/edits-ep");
function cfg() { return { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0 } as any; }

function get(port: number, pathq: string, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    http.get({ port, path: pathq, headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode!, json: d ? JSON.parse(d) : null }));
    });
  });
}

beforeAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
  appendJournal(cfg(), { editId: "a", kind: "set_baseline_note", payloadJSON: "{}", beforeJSON: null, rationale: null });
  appendJournal(cfg(), { editId: "b", kind: "undo", payloadJSON: JSON.stringify({ targetSeq: 1 }), beforeJSON: null, rationale: null });
});

describe("GET /edits", () => {
  it("requires auth", async () => {
    const app = createApp(cfg()); const s = app.listen(0); const port = (s.address() as any).port;
    expect((await get(port, "/edits")).status).toBe(401); s.close();
  });
  it("returns the sequenced journal including undo rows, filtered by since", async () => {
    const app = createApp(cfg()); const s = app.listen(0); const port = (s.address() as any).port;
    const all = await get(port, "/edits", cfg().roToken);
    expect(all.json.edits.length).toBe(2);
    expect(all.json.latestSeq).toBe(2);
    const tail = await get(port, "/edits?since=1", cfg().roToken);
    expect(tail.json.edits.map((e: any) => e.editId)).toEqual(["b"]);
    const bad = await get(port, "/edits?since=zzz", cfg().roToken);
    expect(bad.status).toBe(400); s.close();
  });
});
