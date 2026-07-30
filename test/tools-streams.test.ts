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

beforeAll(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
  const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), cfg);
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

  // Regression: `gaps` was computed as `!readBy && GAP_CANDIDATES.has(table)` over an allow-list that was
  // a strict SUBSET of STREAM_READERS, so the predicate was unsatisfiable for every table and every
  // database — `gaps` was a hardcoded [] computed the long way, and the live mirror reported "every
  // populated biometric stream has a reader" while carrying 245k unreadable rows. These three tests fail
  // against that implementation.
  it("flags a populated table that no tool reads", () => {
    const db = new Database(cfg.mirrorPath);
    db.exec(`CREATE TABLE IF NOT EXISTS mysteryStream (deviceId TEXT, ts INTEGER, v REAL, PRIMARY KEY(deviceId, ts));`);
    db.prepare("INSERT OR REPLACE INTO mysteryStream VALUES (?,?,?)").run("my-whoop", 1780000001, 1.5);
    db.close();
    const r = streamsInventory(cfg) as any;
    expect(r.gaps).toContain("mysteryStream");   // a table added by a future migration must not be invisible
    expect(r.note).toMatch(/capture that no tool can retrieve/);
  });

  it("annotates a gap without suppressing it — a note explains, it does not hide", () => {
    const db = new Database(cfg.mirrorPath);
    db.exec(`CREATE TABLE IF NOT EXISTS v18AuxSample (deviceId TEXT, ts INTEGER, blob BLOB, PRIMARY KEY(deviceId, ts));`);
    db.prepare("INSERT OR REPLACE INTO v18AuxSample VALUES (?,?,?)").run("my-whoop", 1780000002, Buffer.from([1]));
    db.close();
    const r = streamsInventory(cfg) as any;
    const aux = r.streams.find((s: any) => s.table === "v18AuxSample");
    expect(aux.readBy).toBeNull();
    expect(aux.note).toMatch(/deliberately ships no consumer/);
    expect(r.gaps).toContain("v18AuxSample");
  });

  it("never flags bookkeeping tables, and no longer claims deep_buffer_* reads rawBatch", () => {
    const db = new Database(cfg.mirrorPath);
    db.exec(`CREATE TABLE IF NOT EXISTS cursors (k TEXT PRIMARY KEY, v TEXT);`);
    db.prepare("INSERT OR REPLACE INTO cursors VALUES (?,?)").run("last", "1");
    db.exec(`CREATE TABLE IF NOT EXISTS rawBatch (deviceId TEXT, startTs INTEGER, framesBlob BLOB, PRIMARY KEY(deviceId, startTs));`);
    db.prepare("INSERT OR REPLACE INTO rawBatch VALUES (?,?,?)").run("my-whoop", 1780000003, Buffer.from([1]));
    db.close();
    const r = streamsInventory(cfg) as any;
    expect(r.gaps).not.toContain("cursors");
    // deep_buffer_coverage / deep_buffer_window SELECT FROM the server-side deepBufferChunk table, not
    // this one — the old readBy entry was both false and a gap-detection suppressor.
    const raw = r.streams.find((s: any) => s.table === "rawBatch");
    expect(raw.readBy).toBeNull();
    expect(r.gaps).toContain("rawBatch");
  });
});
