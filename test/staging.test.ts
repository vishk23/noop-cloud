import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { createProposal, getProposal, listPending, resolveProposal, appendJournal, journalSince, activeEdits, markUndone } from "../src/staging.js";

const dataDir = path.join(process.cwd(), "test/.tmp/staging");
const cfg = { serverDbPath: path.join(dataDir, "server.sqlite") } as any;
beforeEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

const draft = (id: string) => ({ id, kind: "delete_workout", payloadJSON: JSON.stringify({ deviceId: "my-whoop", startTs: 100, sport: "running" }), rationale: "duplicate", beforeJSON: JSON.stringify({ sport: "running" }), diffText: "- running workout @100" });

describe("staging state machine", () => {
  it("propose → pending → confirm; not listed after", () => {
    createProposal(cfg, draft("edit_a"));
    expect(listPending(cfg).map((p) => p.id)).toEqual(["edit_a"]);
    const r = resolveProposal(cfg, "edit_a", "confirmed");
    expect(r?.status).toBe("confirmed");
    expect(listPending(cfg)).toEqual([]);
  });
  it("resolve is single-shot (second resolve returns null)", () => {
    createProposal(cfg, draft("edit_b"));
    expect(resolveProposal(cfg, "edit_b", "rejected")?.status).toBe("rejected");
    expect(resolveProposal(cfg, "edit_b", "confirmed")).toBeNull();
  });
  it("journal is append-only, sequenced, idempotent by editId", () => {
    const s1 = appendJournal(cfg, { editId: "edit_c", kind: "delete_workout", payloadJSON: "{}", beforeJSON: null, rationale: null });
    const s2 = appendJournal(cfg, { editId: "edit_d", kind: "set_baseline_note", payloadJSON: "{}", beforeJSON: null, rationale: null });
    expect(s2).toBe(s1 + 1);
    expect(() => appendJournal(cfg, { editId: "edit_c", kind: "delete_workout", payloadJSON: "{}", beforeJSON: null, rationale: null })).toThrow();
    expect(journalSince(cfg, s1).map((j) => j.seq)).toEqual([s2]);
  });
  it("undo marks original inactive; undo rows never count as active", () => {
    const s1 = appendJournal(cfg, { editId: "edit_e", kind: "delete_workout", payloadJSON: "{}", beforeJSON: null, rationale: null });
    const s2 = appendJournal(cfg, { editId: "undo_of_e", kind: "undo", payloadJSON: JSON.stringify({ targetSeq: s1 }), beforeJSON: null, rationale: null });
    markUndone(cfg, s1, s2);
    expect(activeEdits(cfg)).toEqual([]);
    expect(journalSince(cfg, 0).length).toBe(2); // history intact
  });
});
