import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { appendJournal } from "../src/staging.js";
import { payloadSchema, EDIT_KINDS } from "../src/edits/kinds.js";
import { captureBefore, renderDiff } from "../src/edits/diff.js";
import { computeOverlay, sleepKeyOf } from "../src/edits/overlay.js";
import { hrSeries, sleepDetail } from "../src/tools/granular.js";

const dataDir = path.join(process.cwd(), "test/.tmp/edits-granular");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const NIGHT = Math.floor(new Date("2026-06-13T03:00:00Z").getTime() / 1000);
const NEW_STAGES = [{ start: NIGHT, end: NIGHT + 10800, stage: "deep" }, { start: NIGHT + 10800, end: NIGHT + 25200, stage: "light" }];
// Contiguous ascending stage segments starting at NIGHT, cycling through every stage enum value —
// used to exercise the segment-count cap (edit_sleep_stages.stages.max) without also having to hand
// -build a semantically realistic hypnogram.
const CYCLE = ["light", "deep", "rem", "awake"] as const;
function buildStages(n: number) {
  const stages: { start: number; end: number; stage: string }[] = [];
  for (let i = 0; i < n; i++) stages.push({ start: NIGHT + i * 60, end: NIGHT + (i + 1) * 60, stage: CYCLE[i % CYCLE.length] });
  return stages;
}

beforeAll(async () => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), cfg); });

describe("granular edit kinds", () => {
  it("EDIT_KINDS is 9 and schemas validate", () => {
    expect(EDIT_KINDS.length).toBe(9); // + add_annotation (docs/ANNOTATIONS_DESIGN.md)
    expect(payloadSchema("edit_sleep_stages").safeParse({ deviceId: "my-whoop", startTs: NIGHT, stages: NEW_STAGES }).success).toBe(true);
    expect(payloadSchema("edit_sleep_stages").safeParse({ deviceId: "d", startTs: 1, stages: [{ start: 5, end: 4, stage: "deep" }] }).success).toBe(false);
    expect(payloadSchema("delete_hr_range").safeParse({ deviceId: "my-whoop", fromTs: NIGHT, toTs: NIGHT + 30000 }).success).toBe(false); // >6h
  });
  it("edit_sleep_stages accepts a real fragmented night's 114 segments (cap raised from 96 to 256)", () => {
    // Audit-exposed: a genuinely fragmented 9.4h night produced 114 stage segments and was rejected
    // outright by the old 96 cap — this wasn't a malformed payload, just fine-grained real data.
    const r = payloadSchema("edit_sleep_stages").safeParse({ deviceId: "my-whoop", startTs: NIGHT, stages: buildStages(114) });
    expect(r.success).toBe(true);
  });
  it("edit_sleep_stages still rejects beyond the 256 cap", () => {
    const r = payloadSchema("edit_sleep_stages").safeParse({ deviceId: "my-whoop", startTs: NIGHT, stages: buildStages(257) });
    expect(r.success).toBe(false);
  });
  it("captureBefore + renderDiff for both kinds", () => {
    const b1 = captureBefore(cfg, "edit_sleep_stages", { deviceId: "my-whoop", startTs: NIGHT, stages: NEW_STAGES }) as any;
    expect(b1.stagesJSON).toBeTruthy();
    expect(renderDiff("edit_sleep_stages", { deviceId: "my-whoop", startTs: NIGHT, stages: NEW_STAGES }, b1)).toContain("deep");
    const b2 = captureBefore(cfg, "delete_hr_range", { deviceId: "my-whoop", fromTs: NIGHT, toTs: NIGHT + 3600 }) as any;
    expect(b2.count).toBeGreaterThan(0);
    expect(renderDiff("delete_hr_range", { deviceId: "my-whoop", fromTs: NIGHT, toTs: NIGHT + 3600 }, b2)).toMatch(/DELETE \d+ HR/);
  });
  it("journal entries flow into overlay and granular reads", () => {
    appendJournal(cfg, { editId: "g1", kind: "edit_sleep_stages", payloadJSON: JSON.stringify({ deviceId: "my-whoop", startTs: NIGHT, stages: NEW_STAGES }), beforeJSON: null, rationale: null });
    appendJournal(cfg, { editId: "g2", kind: "delete_hr_range", payloadJSON: JSON.stringify({ deviceId: "my-whoop", fromTs: NIGHT, toTs: NIGHT + 3599 }), beforeJSON: null, rationale: null });
    const o = computeOverlay(cfg);
    expect(o.stageEdits.get(sleepKeyOf("my-whoop", NIGHT))?.stages.length).toBe(2);
    expect(o.deletedHrRanges.length).toBe(1);
    const d = sleepDetail(cfg, { deviceId: "my-whoop", startTs: NIGHT }) as any;
    expect(d.stagesEdited).toBe(true);
    expect(d.stages.length).toBe(2);
    const hr = hrSeries(cfg, { from: "2026-06-13T03:00:00Z", to: "2026-06-13T10:00:00Z", deviceId: "my-whoop" }) as any;
    const inRange = hr.samples.filter((s: any) => s.ts >= NIGHT && s.ts <= NIGHT + 3599);
    expect(inRange.length).toBe(0); // deleted range excluded
  });
});
