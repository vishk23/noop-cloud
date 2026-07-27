import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path"; import Database from "better-sqlite3";
import { buildNoopbak } from "./fixtures/make-fixture.js"; import { ingestNoopbak } from "../src/ingest.js";
import { metricSeries, sleepSummary, workoutSummary } from "../src/tools/query.js";

const dataDir = path.join(process.cwd(), "test/.tmp/tools-query");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
beforeAll(async () => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), cfg); });

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
  it("sleep_summary tolerates a mirror with no phoneTimezone table (older upload): no tzId, no crash", () => {
    // The fixture mirror predates the v28 phoneTimezone table (make-fixture never creates it).
    const r = sleepSummary(cfg, { from: "2026-06-10", to: "2026-06-13" });
    expect(r.sessions.every((s) => !("tzId" in s))).toBe(true);
  });
  it("workout_summary returns a running workout", () => {
    const r = workoutSummary(cfg, { from: "2026-06-10", to: "2026-06-13" });
    expect(r.workouts.some((w) => w.sport === "running")).toBe(true);
  });
  it("sleep_summary attaches per-night tzId, resolving the local day across the UTC boundary", async () => {
    const tzDir = path.join(process.cwd(), "test/.tmp/tools-query-tz");
    fs.rmSync(tzDir, { recursive: true, force: true }); fs.mkdirSync(tzDir, { recursive: true });
    const tzCfg = { dataDir: tzDir, mirrorPath: path.join(tzDir, "mirror.sqlite"), serverDbPath: path.join(tzDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
    const z = path.join(tzDir, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), tzCfg);

    // Seed the v28 phoneTimezone table into the mirror. The my-whoop session on the last fixture day
    // starts at 03:00 UTC on 2026-06-13, which is the EVENING of 2026-06-12 in Los Angeles — so the
    // phone stamped 2026-06-12, not the UTC day. tzForStart must resolve to the correct night's zone.
    const mdb = new Database(tzCfg.mirrorPath);
    mdb.exec("CREATE TABLE phoneTimezone (day TEXT PRIMARY KEY, tzId TEXT NOT NULL)");
    mdb.prepare("INSERT INTO phoneTimezone VALUES (?,?)").run("2026-06-12", "America/Los_Angeles");
    mdb.close();

    const r = sleepSummary(tzCfg, { from: "2026-06-10", to: "2026-06-13" });
    const lastNight = r.sessions.filter((s: any) => s.deviceId === "my-whoop").at(-1) as any;
    expect(lastNight.tzId).toBe("America/Los_Angeles");
    // Sessions on nights with no stored tz carry no tzId field.
    const firstNight = r.sessions.filter((s: any) => s.deviceId === "my-whoop")[0] as any;
    expect("tzId" in firstNight).toBe(false);
  });

  it("query tools return structured not-ingested response before first ingest", () => {
    const emptyDir = path.join(process.cwd(), "test/.tmp/tools-query-empty");
    fs.rmSync(emptyDir, { recursive: true, force: true });
    fs.mkdirSync(emptyDir, { recursive: true });
    const cfg2 = { dataDir: emptyDir, mirrorPath: path.join(emptyDir, "mirror.sqlite"), serverDbPath: path.join(emptyDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;

    const metricRes = metricSeries(cfg2, { from: "2026-06-10", to: "2026-06-13" });
    expect(metricRes.points).toEqual([]);
    expect(metricRes.notIngested).toBe(true);

    const sleepRes = sleepSummary(cfg2, { from: "2026-06-10", to: "2026-06-13" });
    expect(sleepRes.sessions).toEqual([]);
    expect(sleepRes.notIngested).toBe(true);

    const workoutRes = workoutSummary(cfg2, { from: "2026-06-10", to: "2026-06-13" });
    expect(workoutRes.workouts).toEqual([]);
    expect(workoutRes.notIngested).toBe(true);
  });
});
