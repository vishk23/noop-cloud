import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { buildNoopbak } from "./fixtures/make-fixture.js"; import { ingestNoopbak } from "../src/ingest.js";
import { metricSeries, sleepSummary, workoutSummary } from "../src/tools/query.js";

const dataDir = path.join(process.cwd(), "test/.tmp/tools-query");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
beforeAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), cfg); });

describe("query tools", () => {
  it("metric_series returns Oura reference keys", () => {
    const r = metricSeries(cfg, { from: "2026-06-10", to: "2026-06-13", deviceId: "oura-api", key: "oura_readiness" });
    expect(r.points.length).toBe(4);
    expect(r.points[0].value).toBe(78);
  });
  it("sleep_summary computes durationMin per family", () => {
    const r = sleepSummary(cfg, { from: "2026-06-10", to: "2026-06-13" });
    expect(r.sessions.length).toBeGreaterThan(0);
    expect(r.sessions[0].durationMin).toBeGreaterThan(0);
  });
  it("workout_summary returns a running workout", () => {
    const r = workoutSummary(cfg, { from: "2026-06-10", to: "2026-06-13" });
    expect(r.workouts.some((w) => w.sport === "running")).toBe(true);
  });
});
