import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { appendJournal, markUndone } from "../src/staging.js";
import { computeOverlay, workoutKeyOf, sleepKeyOf } from "../src/edits/overlay.js";

const dataDir = path.join(process.cwd(), "test/.tmp/overlay");
const cfg = { serverDbPath: path.join(dataDir, "server.sqlite") } as any;
beforeEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

describe("overlay", () => {
  it("folds active edits into lookup structures", () => {
    appendJournal(cfg, { editId: "e1", kind: "delete_workout", payloadJSON: JSON.stringify({ deviceId: "my-whoop", startTs: 100, sport: "running" }), beforeJSON: null, rationale: null });
    appendJournal(cfg, { editId: "e2", kind: "adjust_sleep_bounds", payloadJSON: JSON.stringify({ deviceId: "my-whoop", startTs: 200, newEndTs: 999 }), beforeJSON: null, rationale: null });
    appendJournal(cfg, { editId: "e3", kind: "add_workout", payloadJSON: JSON.stringify({ startTs: 300, endTs: 400, sport: "yoga" }), beforeJSON: null, rationale: null });
    const o = computeOverlay(cfg);
    expect(o.deletedWorkouts.has(workoutKeyOf("my-whoop", 100, "running"))).toBe(true);
    expect(o.sleepBounds.get(sleepKeyOf("my-whoop", 200))?.newEndTs).toBe(999);
    expect(o.addedWorkouts[0]).toMatchObject({ deviceId: "noop-cloud", sport: "yoga" });
  });
  it("undone edits leave the overlay", () => {
    const s = appendJournal(cfg, { editId: "e4", kind: "delete_workout", payloadJSON: JSON.stringify({ deviceId: "d", startTs: 1, sport: "s" }), beforeJSON: null, rationale: null });
    const u = appendJournal(cfg, { editId: "u4", kind: "undo", payloadJSON: JSON.stringify({ targetSeq: s }), beforeJSON: null, rationale: null });
    markUndone(cfg, s, u);
    const o = computeOverlay(cfg);
    expect(o.deletedWorkouts.size).toBe(0);
  });
  it("later sleep adjustments to the same session win", () => {
    appendJournal(cfg, { editId: "e5", kind: "adjust_sleep_bounds", payloadJSON: JSON.stringify({ deviceId: "d", startTs: 5, newEndTs: 10 }), beforeJSON: null, rationale: null });
    appendJournal(cfg, { editId: "e6", kind: "adjust_sleep_bounds", payloadJSON: JSON.stringify({ deviceId: "d", startTs: 5, newEndTs: 20 }), beforeJSON: null, rationale: null });
    expect(computeOverlay(cfg).sleepBounds.get(sleepKeyOf("d", 5))?.newEndTs).toBe(20);
  });
});
