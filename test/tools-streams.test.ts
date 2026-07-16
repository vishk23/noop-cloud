import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { streamsInventory } from "../src/tools/core.js";

// `streams` inventories the whole mirror. The fixture carries hrSample/rrInterval/gravitySample/
// stepSample/dailyMetric/sleepSession/workout/metricSeries; we add sleepStateSample to prove a newly-read
// stream maps to its tool, and an empty spo2Sample to prove a 0-row stream is listed but never a gap.
const dataDir = path.join(process.cwd(), "test/.tmp/streams");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;

beforeAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
  const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), cfg);
  const db = new Database(cfg.mirrorPath);
  db.exec(`CREATE TABLE IF NOT EXISTS sleepStateSample (deviceId TEXT, ts INTEGER, state INTEGER, PRIMARY KEY(deviceId, ts));`);
  db.prepare("INSERT INTO sleepStateSample VALUES (?,?,?)").run("my-whoop", 1780000000, 2);
  db.exec(`CREATE TABLE IF NOT EXISTS spo2Sample (deviceId TEXT, ts INTEGER, red INTEGER, ir INTEGER, PRIMARY KEY(deviceId, ts));`); // stays empty
  db.close();
});

describe("streams", () => {
  it("lists every table with row counts and which tool reads it", () => {
    const r = streamsInventory(cfg) as any;
    const by = Object.fromEntries(r.streams.map((s: any) => [s.table, s]));
    expect(by.hrSample.readBy).toBe("hr_series");
    expect(by.hrSample.rows).toBeGreaterThan(0);
    expect(by.sleepStateSample.readBy).toBe("sleep_state_series");
    expect(by.dailyMetric.readBy).toContain("health_snapshot");
    expect(by.dailyMetric.deviceIds.length).toBeGreaterThan(0);
  });

  it("annotates deliberate non-gaps and never flags a 0-row stream", () => {
    const r = streamsInventory(cfg) as any;
    const spo2 = r.streams.find((s: any) => s.table === "spo2Sample");
    expect(spo2.rows).toBe(0);
    expect(spo2.note).toMatch(/5\/MG/);
    expect(r.gaps).not.toContain("spo2Sample");
  });

  it("reports gaps as an array; the fixture's populated streams are all covered", () => {
    const r = streamsInventory(cfg) as any;
    expect(Array.isArray(r.gaps)).toBe(true);
    expect(r.gaps).toEqual([]); // every populated biometric stream in the fixture has a reader
  });
});
