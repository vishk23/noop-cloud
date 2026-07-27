import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { dataFreshness, healthSnapshot } from "../src/tools/core.js";

const dataDir = path.join(process.cwd(), "test/.tmp/tools-core");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
beforeAll(async () => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), cfg); });

describe("core tools", () => {
  it("data_freshness reports sources + latest day", () => {
    const r = dataFreshness(cfg);
    expect(r.latestDataDay).toBe("2026-06-13");
    expect(r.sources.map((s) => s.deviceId)).toContain("oura-api");
    expect(r.mirrorAgeSeconds).toBeGreaterThanOrEqual(0);
  });
  it("data_freshness surfaces dailyMetric columns + metricSeries keys for discoverability (post-hoc audit fix)", () => {
    // The audit that motivated this wasted a whole agent-run failing to find skinTempDevC because
    // nothing listed valid dailyMetric column / metricSeries key names.
    const r = dataFreshness(cfg) as any;
    expect(r.dailyMetricColumns.length).toBeGreaterThan(0);
    expect(r.dailyMetricColumns).toContain("skinTempDevC");
    expect(r.dailyMetricColumns).toContain("restingHr");
    expect(r.dailyMetricColumns).not.toContain("deviceId"); // identity columns excluded
    expect(r.dailyMetricColumns).not.toContain("day");

    expect(r.metricSeriesKeys.length).toBeGreaterThan(0);
    const byKey = Object.fromEntries(r.metricSeriesKeys.map((k: any) => [k.key, k.counts]));
    expect(byKey.vo2max).toBeDefined();
    expect(byKey.vo2max.apple).toBeGreaterThan(0);
    expect(byKey.vo2max.whoop).toBeGreaterThan(0);
  });
  it("data_freshness sources report which tables each device appears in", () => {
    const r = dataFreshness(cfg) as any;
    const oura = r.sources.find((s: any) => s.deviceId === "oura-api");
    expect(oura.tables).toContain("dailyMetric");
    expect(oura.tables).toContain("hrSample");
  });
  it("data_freshness sources surface rrInterval only for devices that actually carry R-R data (WHOOP-only)", () => {
    const r = dataFreshness(cfg) as any;
    const whoop = r.sources.find((s: any) => s.deviceId === "my-whoop");
    expect(whoop.tables).toContain("rrInterval");
    const oura = r.sources.find((s: any) => s.deviceId === "oura-api");
    expect(oura.tables).not.toContain("rrInterval"); // Oura's API never exposes beat-to-beat R-R data
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
  it("data_freshness surfaces phoneTz from the latest ingest (null when none was sent)", async () => {
    const r = dataFreshness(cfg) as any;
    // The shared fixture ingest sent no header → null.
    expect(r.phoneTz).toBeNull();

    // A fresh ingest carrying a timezone surfaces it.
    const tzDir = path.join(process.cwd(), "test/.tmp/tools-core-tz");
    fs.rmSync(tzDir, { recursive: true, force: true }); fs.mkdirSync(tzDir, { recursive: true });
    const tzCfg = { dataDir: tzDir, mirrorPath: path.join(tzDir, "mirror.sqlite"), serverDbPath: path.join(tzDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
    const z = path.join(tzDir, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), tzCfg, "America/New_York");
    expect((dataFreshness(tzCfg) as any).phoneTz).toBe("America/New_York");
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
