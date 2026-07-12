import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { appendJournal } from "../src/staging.js";
import { sleepSummary, workoutSummary, metricSeries } from "../src/tools/query.js";
import { dataFreshness } from "../src/tools/core.js";

const dataDir = path.join(process.cwd(), "test/.tmp/overlay-reads");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const SLEEP_TS = Math.floor(new Date("2026-06-13T03:00:00Z").getTime() / 1000);
const RUN_TS = Math.floor(new Date("2026-06-12T18:00:00Z").getTime() / 1000);
const NEW_END = Math.floor(new Date("2026-06-13T06:00:00Z").getTime() / 1000);

beforeAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
  const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), cfg);
  appendJournal(cfg, { editId: "e_sleep", kind: "adjust_sleep_bounds", payloadJSON: JSON.stringify({ deviceId: "my-whoop", startTs: SLEEP_TS, newEndTs: NEW_END }), beforeJSON: null, rationale: null });
  appendJournal(cfg, { editId: "e_del", kind: "delete_workout", payloadJSON: JSON.stringify({ deviceId: "my-whoop", startTs: RUN_TS, sport: "running" }), beforeJSON: null, rationale: null });
  appendJournal(cfg, { editId: "e_add", kind: "add_workout", payloadJSON: JSON.stringify({ startTs: RUN_TS + 7200, endTs: RUN_TS + 9000, sport: "yoga" }), beforeJSON: null, rationale: null });
  appendJournal(cfg, { editId: "e_pt", kind: "delete_metric_point", payloadJSON: JSON.stringify({ deviceId: "oura-api", day: "2026-06-13", key: "oura_readiness" }), beforeJSON: null, rationale: null });
  appendJournal(cfg, { editId: "e_note", kind: "set_baseline_note", payloadJSON: JSON.stringify({ note: "oura RHR reads ~2bpm high", deviceId: "oura-api" }), beforeJSON: null, rationale: null });
});

describe("overlay-aware reads", () => {
  it("sleep_summary reflects adjusted end + recomputed duration + provenance", () => {
    const s = sleepSummary(cfg, { from: "2026-06-13", to: "2026-06-13" }).sessions.find((x: any) => x.deviceId === "my-whoop");
    expect(s.endTs).toBe(NEW_END);
    expect(s.durationMin).toBe(Math.round((NEW_END - SLEEP_TS) / 60));
    expect(s.edited).toBe(true);
  });
  it("workout_summary hides deleted, shows added with provenance", () => {
    const w = workoutSummary(cfg, { from: "2026-06-11", to: "2026-06-13" });
    expect(w.workouts.find((x: any) => x.sport === "running")).toBeUndefined();
    const added = w.workouts.find((x: any) => x.sport === "yoga");
    expect(added.deviceId).toBe("noop-cloud");
    expect(added.added).toBe(true);
  });
  it("metric_series drops deleted points", () => {
    const r = metricSeries(cfg, { deviceId: "oura-api", key: "oura_readiness", from: "2026-06-10", to: "2026-06-13" });
    expect(r.points.length).toBe(3); // fixture had 4 days
  });
  it("data_freshness reports journal state + notes", () => {
    const f = dataFreshness(cfg) as any;
    expect(f.journalSeq).toBeGreaterThanOrEqual(5);
    expect(f.baselineNotes[0].note).toContain("RHR");
  });
  it("workout_summary applies fix_workout patches and recomputes BOTH durations", () => {
    const WALK_TS = Math.floor(new Date("2026-06-11T17:00:00Z").getTime() / 1000);
    appendJournal(cfg, { editId: "e_fix", kind: "fix_workout", payloadJSON: JSON.stringify({ deviceId: "oura-api", startTs: WALK_TS, sport: "walking", patch: { endTs: WALK_TS + 4800 } }), beforeJSON: null, rationale: null });
    const w = workoutSummary(cfg, { from: "2026-06-11", to: "2026-06-11" }).workouts.find((x: any) => x.sport === "walking") as any;
    expect(w.edited).toBe(true);
    expect(w.endTs).toBe(WALK_TS + 4800);
    expect(w.durationS).toBe(4800);
    expect(w.durationMin).toBe(80);
  });
});
