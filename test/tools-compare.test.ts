import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { compareSources } from "../src/tools/compare.js";

const dataDir = path.join(process.cwd(), "test/.tmp/tools-compare");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
beforeAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), cfg); });

describe("compare_sources", () => {
  it("puts WHOOP/Oura/Apple restingHr side by side with a spread", () => {
    const r = compareSources(cfg, { from: "2026-06-13", to: "2026-06-13", metrics: ["restingHr"] });
    const day = r.days[0];
    expect(day.metrics.restingHr.whoop).toBe(51);
    expect(day.metrics.restingHr.oura).toBe(53);
    expect(day.metrics.restingHr.apple).toBe(54);
    expect(day.metrics.restingHr.spreadPct).toBeGreaterThan(0);
  });
  it("omits families with a null value (Apple avgHrv)", () => {
    const r = compareSources(cfg, { from: "2026-06-13", to: "2026-06-13", metrics: ["avgHrv"] });
    expect(r.days[0].metrics.avgHrv.apple).toBeUndefined();
    expect(r.days[0].metrics.avgHrv.whoop).toBe(70);
  });
  it("averages same-family multi-device values and surfaces the disagreement via perDevice", () => {
    // recovery: only WHOOP-family devices report it — my-whoop=66, my-whoop-noop=58.
    // whoop cell should be their mean, with the raw per-device split visible (not hidden).
    const r = compareSources(cfg, { from: "2026-06-13", to: "2026-06-13", metrics: ["recovery"] });
    const recovery = r.days[0].metrics.recovery;
    expect(recovery.whoop).toBe(62);
    expect(recovery.perDevice).toEqual({ "my-whoop": 66, "my-whoop-noop": 58 });
  });
});

describe("compare_sources guard: empty mirror", () => {
  it("returns notIngested: true when mirror path does not exist", () => {
    const emptyDir = path.join(process.cwd(), "test/.tmp/tools-compare-empty");
    const emptyCfg = { dataDir: emptyDir, mirrorPath: path.join(emptyDir, "nonexistent.sqlite"), serverDbPath: path.join(emptyDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
    fs.rmSync(emptyDir, { recursive: true, force: true });
    fs.mkdirSync(emptyDir, { recursive: true });
    const r = compareSources(emptyCfg, { from: "2026-06-13", to: "2026-06-13" });
    expect(r.days).toEqual([]);
    expect(r.notIngested).toBe(true);
  });
});
