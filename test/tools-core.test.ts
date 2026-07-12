import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { dataFreshness, healthSnapshot } from "../src/tools/core.js";

const dataDir = path.join(process.cwd(), "test/.tmp/tools-core");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
beforeAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), cfg); });

describe("core tools", () => {
  it("data_freshness reports sources + latest day", () => {
    const r = dataFreshness(cfg);
    expect(r.latestDataDay).toBe("2026-06-13");
    expect(r.sources.map((s) => s.deviceId)).toContain("oura-api");
    expect(r.mirrorAgeSeconds).toBeGreaterThanOrEqual(0);
  });
  it("health_snapshot rolls up recent days by family", () => {
    const r = healthSnapshot(cfg, { days: 2 });
    expect(r.days.length).toBe(2);
    const last = r.days[r.days.length - 1];
    expect(last.day).toBe("2026-06-13");
    expect(last.whoop?.recovery).toBe(66);
    expect(last.oura?.restingHr).toBe(53);
  });
  it("health_snapshot merges same-family multi-device rows without erasing real data", () => {
    // my-whoop (strap: sleep/HR/recovery) and my-whoop-noop (derived: recovery/strain only,
    // all else null) are both family "whoop". The merge must not let my-whoop-noop's nulls
    // clobber my-whoop's real values, and both deviceIds must be listed as sources.
    const r = healthSnapshot(cfg, { days: 1 });
    const last = r.days[r.days.length - 1];
    expect(last.whoop.totalSleepMin).toBe(420);
    expect(last.whoop.recovery).toBe(66);
    expect(last.whoop.sources).toEqual(["my-whoop", "my-whoop-noop"]);
  });
  it("tools return structured not-ingested response before first ingest", () => {
    const emptyDir = path.join(process.cwd(), "test/.tmp/tools-empty");
    fs.rmSync(emptyDir, { recursive: true, force: true });
    fs.mkdirSync(emptyDir, { recursive: true });
    const emptyCfg = { dataDir: emptyDir, mirrorPath: path.join(emptyDir, "mirror.sqlite"), serverDbPath: path.join(emptyDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;

    const freshness = dataFreshness(emptyCfg);
    expect(freshness.sources).toEqual([]);
    expect(freshness.notIngested).toBe(true);

    const snapshot = healthSnapshot(emptyCfg, { days: 3 });
    expect(snapshot.days).toEqual([]);
    expect(snapshot.notIngested).toBe(true);
  });
});
