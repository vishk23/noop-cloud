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
