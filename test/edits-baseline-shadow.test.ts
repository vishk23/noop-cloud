import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { appendJournal, markUndone } from "../src/staging.js";
import { captureBefore, renderDiff } from "../src/edits/diff.js";

// The near-miss this exists for: set_baseline_note's journal is append-only, but every reader
// (latestBaselineNotes in src/tools/core.ts) surfaces only the LATEST note per deviceId. Writing a
// second note for a device therefore makes the first invisible, and nothing said so — not in
// propose_edit's response and, worse, not in the diff a human confirms against in list_pending.
const dataDir = path.join(process.cwd(), "test/.tmp/baseline-shadow");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite") } as any;
beforeEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

function note(editId: string, note: string, deviceId?: string) {
  appendJournal(cfg, { editId, kind: "set_baseline_note", payloadJSON: JSON.stringify({ note, ...(deviceId ? { deviceId } : {}) }), beforeJSON: null, rationale: null });
}
const render = (payload: any) => renderDiff("set_baseline_note", payload, captureBefore(cfg, "set_baseline_note", payload));

describe("set_baseline_note shadowing warning", () => {
  it("the FIRST note for a device gets a plain one-line diff", () => {
    const d = render({ note: "protocol running", deviceId: "my-whoop-noop" });
    expect(d).toBe("NOTE [my-whoop-noop]: protocol running");
    expect(captureBefore(cfg, "set_baseline_note", { note: "x", deviceId: "my-whoop-noop" })).toBeNull();
  });

  it("a SECOND note for the same device warns, quotes what it hides, and points at add_annotation", () => {
    note("n1", "Performance-supplement protocol. Read elevated temp as the protocol, NOT illness.", "my-whoop-noop");
    const d = render({ note: "new standing fact", deviceId: "my-whoop-noop" });
    expect(d).toContain("⚠ REPLACES the current note for my-whoop-noop");
    expect(d).toContain("Performance-supplement protocol");
    expect(d).toContain("add_annotation");
    // The warning has to live in the diff itself: list_pending shows only diffText, and that is
    // where the confirm decision is actually made.
    expect(d.split("\n").length).toBeGreaterThan(1);
  });

  it("the null-deviceId slot shadows independently of a device's notes", () => {
    note("n1", "device-scoped standing fact", "my-whoop-noop");
    // A note with no deviceId does NOT collide with the device-scoped one...
    expect(render({ note: "first global note" })).toBe("NOTE: first global note");
    note("n2", "first global note");
    // ...but a second null-deviceId note shadows the first, and says so.
    const d = render({ note: "second global note" });
    expect(d).toContain("⚠ REPLACES the current note for no deviceId");
    expect(d).toContain("first global note");
    // The device-scoped note is still untouched by any of this.
    expect(render({ note: "another device note", deviceId: "my-whoop-noop" })).toContain("device-scoped standing fact");
  });

  it("shadows against the LATEST note, not the first, and truncates a long quote", () => {
    note("n1", "oldest", "d");
    note("n2", "middle", "d");
    note("n3", "x".repeat(400), "d");
    const d = render({ note: "newest", deviceId: "d" });
    expect(d).toContain("…");
    expect(d).not.toContain("middle");
    expect(d).not.toContain("oldest");
  });

  it("an undone note stops shadowing — captureBefore reads the live overlay, not raw history", () => {
    const seq = appendJournal(cfg, { editId: "n1", kind: "set_baseline_note", payloadJSON: JSON.stringify({ note: "gone", deviceId: "d" }), beforeJSON: null, rationale: null });
    const u = appendJournal(cfg, { editId: "u1", kind: "undo", payloadJSON: JSON.stringify({ targetSeq: seq }), beforeJSON: null, rationale: null });
    markUndone(cfg, seq, u);
    expect(captureBefore(cfg, "set_baseline_note", { note: "next", deviceId: "d" })).toBeNull();
  });

  it("add_annotation captures no before-state — there is nothing it can shadow", () => {
    note("n1", "standing", "d");
    expect(captureBefore(cfg, "add_annotation", { day: "2026-07-30", tags: ["alcohol"], detail: "d", source: "user_reported" })).toBeNull();
  });
});

describe("add_annotation diff", () => {
  const base = { day: "2026-07-30", tags: ["alcohol", "dehydration"], detail: "VK drank and vomited", source: "user_reported" };
  it("renders day, tags and source on one line", () => {
    expect(renderDiff("add_annotation", base, null)).toBe("ANNOTATE 2026-07-30 [alcohol, dehydration] (user_reported): VK drank and vomited");
  });
  it("renders a span, an instant and the values bag", () => {
    const d = renderDiff("add_annotation", { ...base, endDay: "2026-08-02", startTs: Math.floor(Date.UTC(2026, 6, 30, 23, 8) / 1000), values: { drinks: 6 } }, null);
    expect(d).toContain("2026-07-30..2026-08-02");
    expect(d).toContain("@ 2026-07-30 23:08Z");
    expect(d).toContain('{"drinks":6}');
  });
  it("truncates a long detail so list_pending stays readable", () => {
    expect(renderDiff("add_annotation", { ...base, detail: "y".repeat(500) }, null)).toContain("…");
  });
});
