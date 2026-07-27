import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { imuSeries } from "../src/tools/granular.js";

// imu_series reads the WhoopStore v28 `imuActivity` table (per-second IMU activity features). The stock
// fixture mirror doesn't carry it, so we ingest the standard noopbak and then write the table straight
// into the mirror sqlite — exactly the shape a v28 app upload produces — and a second mirror WITHOUT it
// exercises the notCaptured (older-upload / no-capture) path.
const dataDir = path.join(process.cwd(), "test/.tmp/imu");
const bareDir = path.join(process.cwd(), "test/.tmp/imu-bare");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const bareCfg = { dataDir: bareDir, mirrorPath: path.join(bareDir, "mirror.sqlite"), serverDbPath: path.join(bareDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const T0 = Math.floor(new Date("2026-06-13T12:00:00Z").getTime() / 1000); // on a 300 s bucket boundary

beforeAll(async () => {
  for (const [d, c] of [[dataDir, cfg], [bareDir, bareCfg]] as const) {
    fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
    const z = path.join(d, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), c);
  }
  // Add imuActivity to the main mirror only: bucket A = 60 still seconds, bucket B = 60 walking seconds.
  const db = new Database(cfg.mirrorPath);
  db.exec(`CREATE TABLE IF NOT EXISTS imuActivity (deviceId TEXT, ts INTEGER, accelEnergyG REAL, gyroEnergyDps REAL, jerkRms REAL, cadenceHz REAL, cadenceStrength REAL, sampleCount INTEGER, PRIMARY KEY(deviceId, ts));`);
  const ins = db.prepare("INSERT INTO imuActivity VALUES (?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 60; i++) ins.run("my-whoop", T0 + i, 0.01, 1.0, 0.005, null, 0.05, 100);          // still
  for (let i = 0; i < 60; i++) ins.run("my-whoop", T0 + 300 + i, 0.30, 40.0, 0.08, 1.8, 0.6, 600);     // walk 1.8 Hz
  db.close();
});

describe("imu_series", () => {
  it("returns notCaptured on a mirror without the imuActivity table (older upload / capture off)", () => {
    const r = imuSeries(bareCfg, { from: "2026-06-13T00:00:00Z", to: "2026-06-13T23:59:59Z", deviceId: "my-whoop" }) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.buckets).toEqual([]);
  });

  it("buckets energy/jerk and reports the still stretch with no cadence", () => {
    const r = imuSeries(cfg, { from: "2026-06-13T12:00:00Z", to: "2026-06-13T12:15:00Z", deviceId: "my-whoop", bucketSeconds: 300 }) as any;
    expect(r.notCaptured).toBeUndefined();
    const still = r.buckets.find((b: any) => b.ts === T0);
    expect(still.seconds).toBe(60);
    expect(still.family).toBe("whoop");
    expect(still.accelEnergyG).toBeCloseTo(0.01, 3);
    expect(still.cadenceHz).toBeNull();
    expect(still.cadenceStepsPerMin).toBeNull();
    expect(still.rhythmicFraction).toBe(0);
  });

  it("recovers the walking bucket's strength-weighted cadence + steps/min", () => {
    const r = imuSeries(cfg, { from: "2026-06-13T12:00:00Z", to: "2026-06-13T12:15:00Z", deviceId: "my-whoop", bucketSeconds: 300 }) as any;
    const walk = r.buckets.find((b: any) => b.ts === T0 + 300);
    expect(walk.seconds).toBe(60);
    expect(walk.cadenceHz).toBeCloseTo(1.8, 2);
    expect(walk.cadenceStepsPerMin).toBe(108);          // 1.8 Hz * 60
    expect(walk.rhythmicFraction).toBe(1);
    expect(walk.gyroEnergyDps).toBeCloseTo(40, 1);
    expect(walk.accelEnergyPeakG).toBeCloseTo(0.30, 2);
  });

  it("rejects a span wider than 7 days", () => {
    const r = imuSeries(cfg, { from: "2026-06-01", to: "2026-06-30", deviceId: "my-whoop" }) as any;
    expect(r.error).toBe("span_too_wide");
  });
});
