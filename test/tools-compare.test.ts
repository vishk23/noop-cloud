import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { buildNoopbak, buildMirrorSqlite, buildNoopbakFrom } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { appendJournal } from "../src/staging.js";
import { compareSources } from "../src/tools/compare.js";

const dataDir = path.join(process.cwd(), "test/.tmp/tools-compare");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
beforeAll(async () => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), cfg); });

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
  it("falls back to metricSeries for a metric with no dailyMetric column at all (pure fallback)", () => {
    // vo2max exists only in metricSeries (apple-health=41, my-whoop=45) — proves the fallback
    // path works generically, not just for the steps special case.
    const r = compareSources(cfg, { from: "2026-06-13", to: "2026-06-13", metrics: ["vo2max"] });
    const vo2max = r.days[0].metrics.vo2max;
    expect(vo2max.apple).toBe(41);
    expect(vo2max.whoop).toBe(45);
  });
  it("prefers dailyMetric over the metricSeries fallback when both exist (Apple steps precedence)", () => {
    // Fixture pins apple-health dailyMetric.steps=8200 AND metricSeries steps=9100 for the same
    // day/device. dailyMetric must win — the 9100 fallback value must not leak through.
    const r = compareSources(cfg, { from: "2026-06-13", to: "2026-06-13", metrics: ["steps"] });
    const steps = r.days[0].metrics.steps;
    expect(steps.apple).toBe(8200);
    expect(steps.whoop).toBe(8000); // sanity: dailyMetric-only families unaffected by the fallback path
  });
  it("spreadPct math includes fallback values identically to dailyMetric values", () => {
    // Both whoop (45) and apple (41) for vo2max come purely from the metricSeries fallback.
    const r = compareSources(cfg, { from: "2026-06-13", to: "2026-06-13", metrics: ["vo2max"] });
    const vo2max = r.days[0].metrics.vo2max;
    const expected = Math.round(((45 - 41) / ((45 + 41) / 2)) * 1000) / 10;
    expect(vo2max.spreadPct).toBe(expected);
    expect(vo2max.spreadPct).toBeGreaterThan(0);
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

describe("compare_sources overlay: fallback respects delete_metric_point", () => {
  const overlayDataDir = path.join(process.cwd(), "test/.tmp/tools-compare-overlay");
  const overlayCfg = { dataDir: overlayDataDir, mirrorPath: path.join(overlayDataDir, "mirror.sqlite"), serverDbPath: path.join(overlayDataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
  beforeAll(async () => {
    fs.rmSync(overlayDataDir, { recursive: true, force: true });
    fs.mkdirSync(overlayDataDir, { recursive: true });
    const z = path.join(overlayDataDir, "b.noopbak");
    buildNoopbak(z);
    await ingestNoopbak(fs.readFileSync(z), overlayCfg);
    // Delete the apple-health vo2max for 2026-06-13 — a pure-fallback metric
    appendJournal(overlayCfg, { editId: "e_vo2_del", kind: "delete_metric_point", payloadJSON: JSON.stringify({ deviceId: "apple-health", day: "2026-06-13", key: "vo2max" }), beforeJSON: null, rationale: null });
  });

  it("filters fallback metricSeries rows through deletion overlay, excluding deleted points", () => {
    const r = compareSources(overlayCfg, { from: "2026-06-13", to: "2026-06-13", metrics: ["vo2max"] });
    const vo2max = r.days[0].metrics.vo2max;
    // apple-health deleted, only my-whoop (45) remains
    expect(vo2max.apple).toBeUndefined();
    expect(vo2max.whoop).toBe(45);
    // spreadPct computed with only one value should be 0
    expect(vo2max.spreadPct).toBe(0);
  });

  it("a dailyMetric column deleted via delete_metric_point disappears from compare_sources", () => {
    // Same overlay mechanism as the metricSeries case above, but now targeting a dailyMetric
    // COLUMN directly (post-hoc audit fix): oura-api's restingHr=53 on 2026-06-13.
    appendJournal(overlayCfg, { editId: "e_rhr_del", kind: "delete_metric_point", payloadJSON: JSON.stringify({ deviceId: "oura-api", day: "2026-06-13", key: "restingHr" }), beforeJSON: null, rationale: null });
    const r = compareSources(overlayCfg, { from: "2026-06-13", to: "2026-06-13", metrics: ["restingHr"] });
    const restingHr = r.days[0].metrics.restingHr;
    expect(restingHr.oura).toBeUndefined();
    expect(restingHr.whoop).toBe(51); // unaffected — a different device/family
  });
});

describe("compare_sources day universe: metricSeries-only day (post-hoc audit fix)", () => {
  // Isolated mirror copy (own dataDir), same pattern as tools-motion-dense.test.ts: this needs a
  // day with NO dailyMetric row at all for any device, which the shared fixture doesn't have — so
  // this seeds it directly rather than perturbing the shared fixture's pinned row counts.
  const fbDataDir = path.join(process.cwd(), "test/.tmp/tools-compare-fallback-day");
  const fbCfg = { dataDir: fbDataDir, mirrorPath: path.join(fbDataDir, "mirror.sqlite"), serverDbPath: path.join(fbDataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
  const NEW_DAY = "2026-06-20"; // clear of every DAYS entry in the shared fixture

  beforeAll(async () => {
    fs.rmSync(fbDataDir, { recursive: true, force: true });
    fs.mkdirSync(fbDataDir, { recursive: true });
    const srcSqlite = path.join(fbDataDir, "src.sqlite");
    buildMirrorSqlite(srcSqlite);
    const raw = new Database(srcSqlite);
    // NEW_DAY has NO dailyMetric row for ANY device — its only evidence is this metricSeries
    // fallback row, reproducing the real "Apple steps with no wearable dailyMetric that day"
    // scenario the audit found silently dropped from compare_sources' day universe.
    raw.prepare("INSERT INTO metricSeries VALUES (?,?,?,?)").run("apple-health", NEW_DAY, "steps", 4321);
    raw.close();
    const zip = path.join(fbDataDir, "b.noopbak");
    buildNoopbakFrom(srcSqlite, zip);
    await ingestNoopbak(fs.readFileSync(zip), fbCfg);
  });

  it("surfaces a day whose only data is a metricSeries fallback row", () => {
    const r = compareSources(fbCfg, { from: NEW_DAY, to: NEW_DAY, metrics: ["steps"] });
    const day = r.days.find((d) => d.day === NEW_DAY);
    expect(day).toBeDefined();
    expect(day!.metrics.steps.apple).toBe(4321);
  });
});
