import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { appendJournal } from "../src/staging.js";
import { compensationFor } from "../src/edits/compensation.js";

const dataDir = path.join(process.cwd(), "test/.tmp/compensation");
const cfg = { serverDbPath: path.join(dataDir, "server.sqlite") } as any;
beforeEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

// A synthetic journal row as undo_edit hands one to compensationFor (after markUndone).
function row(seq: number, kind: string, payload: object, beforeJSON: string | null = null): any {
  return { seq, editId: "e" + seq, kind, payloadJSON: JSON.stringify(payload), beforeJSON, rationale: null, appliedAt: 0, undoneBySeq: seq + 1, ackedAt: null };
}

describe("compensationFor", () => {
  it("adjust_sleep_bounds: re-asserts the mirror baseline bounds from beforeJSON when no active edit remains (single-edit undo)", () => {
    // The confirmed live case: seq 41 moved end→30_000; its undo must push the phone back to the
    // mirror's detected 27_000, which only beforeJSON still carries (the mirror is never mutated).
    const before = JSON.stringify({ deviceId: "my-whoop", startTs: 1000, endTs: 27_000, stagesJSON: null });
    const comp = compensationFor(cfg, row(41, "adjust_sleep_bounds", { deviceId: "my-whoop", startTs: 1000, newEndTs: 30_000 }, before));
    expect(comp).not.toBeNull();
    expect(comp!.kind).toBe("adjust_sleep_bounds");
    expect(JSON.parse(comp!.payloadJSON)).toEqual({ deviceId: "my-whoop", startTs: 1000, newStartTs: 1000, newEndTs: 27_000 });
  });

  it("adjust_sleep_bounds: nets to a still-active stacked edit on the same night, not the raw mirror", () => {
    // seq 30 (still active) already moved the end to 28_800; undoing seq 41 must land on 28_800, the
    // net server-overlay value — NOT a naive rewind to the mirror's 27_000.
    appendJournal(cfg, { editId: "e30", kind: "adjust_sleep_bounds", payloadJSON: JSON.stringify({ deviceId: "my-whoop", startTs: 1000, newEndTs: 28_800 }), beforeJSON: null, rationale: null });
    const before = JSON.stringify({ deviceId: "my-whoop", startTs: 1000, endTs: 27_000 });
    const comp = compensationFor(cfg, row(41, "adjust_sleep_bounds", { deviceId: "my-whoop", startTs: 1000, newEndTs: 30_000 }, before));
    expect(JSON.parse(comp!.payloadJSON).newEndTs).toBe(28_800);
  });

  it("adjust_sleep_bounds: no compensation when beforeJSON is missing (nothing to rewind to)", () => {
    expect(compensationFor(cfg, row(41, "adjust_sleep_bounds", { deviceId: "my-whoop", startTs: 1000, newEndTs: 30_000 }, null))).toBeNull();
  });

  it("edit_sleep_stages: re-asserts the mirror's detected stages, mapping the device 'wake' vocab back to 'awake'", () => {
    const before = JSON.stringify({ deviceId: "my-whoop", startTs: 1000, endTs: 27_000, stagesJSON: JSON.stringify([{ start: 1000, end: 4600, stage: "wake" }, { start: 4600, end: 27_000, stage: "deep" }]) });
    const comp = compensationFor(cfg, row(44, "edit_sleep_stages", { deviceId: "my-whoop", startTs: 1000, stages: [{ start: 1000, end: 27_000, stage: "deep" }] }, before));
    expect(comp!.kind).toBe("edit_sleep_stages");
    const stages = JSON.parse(comp!.payloadJSON).stages;
    expect(stages).toHaveLength(2);
    expect(stages[0].stage).toBe("awake"); // normalized to the edit vocabulary the phone remaps
    expect(stages[1].stage).toBe("deep");
  });

  it("edit_sleep_stages: null pre-edit stages (purely derived night) yields no compensation", () => {
    // edit_sleep_stages can't express "no stored stages", so a night that had none stays as-is — a
    // documented cross-batch limitation for that narrow case.
    const before = JSON.stringify({ deviceId: "my-whoop", startTs: 1000, endTs: 27_000, stagesJSON: null });
    expect(compensationFor(cfg, row(44, "edit_sleep_stages", { deviceId: "my-whoop", startTs: 1000, stages: [{ start: 1000, end: 27_000, stage: "deep" }] }, before))).toBeNull();
  });

  it("skips kinds with no phone-applicable forward compensation (note / deletes / adds)", () => {
    expect(compensationFor(cfg, row(5, "set_baseline_note", { note: "x" }))).toBeNull();
    expect(compensationFor(cfg, row(6, "delete_workout", { deviceId: "d", startTs: 1, sport: "run" }, JSON.stringify({ sport: "run", startTs: 1 })))).toBeNull();
    expect(compensationFor(cfg, row(7, "delete_hr_range", { deviceId: "d", fromTs: 1, toTs: 2 }))).toBeNull();
    expect(compensationFor(cfg, row(8, "delete_metric_point", { deviceId: "d", day: "2026-06-12", key: "restingHr" }))).toBeNull();
    expect(compensationFor(cfg, row(9, "add_workout", { startTs: 1, endTs: 2, sport: "run" }))).toBeNull();
  });
});
