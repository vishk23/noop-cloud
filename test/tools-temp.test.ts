import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { tempSeries } from "../src/tools/granular.js";

// temp_series reads the WhoopStore v3 `skinTempSample` table (per-second raw skin-temp register). The
// stock fixture mirror doesn't carry it, so we ingest the standard noopbak and then write the table
// straight in — exactly the shape a real upload produces — and a second mirror WITHOUT it exercises the
// notCaptured (older-upload) path. The fixture's pairedDevice has my-whoop model "5.0" → whoop5 → raw/100.
const dataDir = path.join(process.cwd(), "test/.tmp/temp");
const bareDir = path.join(process.cwd(), "test/.tmp/temp-bare");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const bareCfg = { dataDir: bareDir, mirrorPath: path.join(bareDir, "mirror.sqlite"), serverDbPath: path.join(bareDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const T0 = Math.floor(new Date("2026-06-13T12:00:00Z").getTime() / 1000); // on a 300 s bucket boundary

beforeAll(() => {
  for (const [d, c] of [[dataDir, cfg], [bareDir, bareCfg]] as const) {
    fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
    const z = path.join(d, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), c);
  }
  // Add skinTempSample to the main mirror only: bucket A = 60 s worn steady (raw 3057 = 30.57 °C),
  // bucket B = 60 s alternating 3200/3260 (32.0 / 32.6 °C, avg 32.3).
  const db = new Database(cfg.mirrorPath);
  db.exec(`CREATE TABLE IF NOT EXISTS skinTempSample (deviceId TEXT, ts INTEGER, raw INTEGER, PRIMARY KEY(deviceId, ts));`);
  const ins = db.prepare("INSERT INTO skinTempSample VALUES (?,?,?)");
  for (let i = 0; i < 60; i++) ins.run("my-whoop", T0 + i, 3057);
  for (let i = 0; i < 60; i++) ins.run("my-whoop", T0 + 300 + i, i % 2 === 0 ? 3200 : 3260);
  db.close();
});

describe("temp_series", () => {
  it("returns notCaptured on a mirror without the skinTempSample table (older upload)", () => {
    const r = tempSeries(bareCfg, { from: "2026-06-13T00:00:00Z", to: "2026-06-13T23:59:59Z", deviceId: "my-whoop" }) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.samples).toEqual([]);
  });

  it("buckets raw registers into °C (5/MG raw/100) with min/max/avg and a family tag", () => {
    const r = tempSeries(cfg, { from: "2026-06-13T12:00:00Z", to: "2026-06-13T12:15:00Z", deviceId: "my-whoop", bucketSeconds: 300 }) as any;
    expect(r.notCaptured).toBeUndefined();
    const a = r.buckets.find((x: any) => x.ts === T0);
    expect(a.n).toBe(60);
    expect(a.family).toBe("whoop");
    expect(a.avgC).toBeCloseTo(30.57, 2);
    expect(a.minC).toBeCloseTo(30.57, 2);
    expect(a.maxC).toBeCloseTo(30.57, 2);
    const b = r.buckets.find((x: any) => x.ts === T0 + 300);
    expect(b.n).toBe(60);
    expect(b.minC).toBeCloseTo(32.0, 2);
    expect(b.maxC).toBeCloseTo(32.6, 2);
    expect(b.avgC).toBeCloseTo(32.3, 2);
  });

  it("returns raw samples with both raw and tempC when unbucketed, plus a retention dataExtent", () => {
    const r = tempSeries(cfg, { from: "2026-06-13T12:00:00Z", to: "2026-06-13T12:01:00Z", deviceId: "my-whoop" }) as any;
    expect(r.samples.length).toBe(60);
    expect(r.samples[0]).toMatchObject({ deviceId: "my-whoop", ts: T0, raw: 3057, tempC: 30.57, family: "whoop" });
    expect(r.dataExtent).toMatchObject({ firstTs: T0, lastTs: T0 + 300 + 59, n: 120 });
  });

  it("rejects a span wider than 7 days", () => {
    const r = tempSeries(cfg, { from: "2026-06-01", to: "2026-06-30", deviceId: "my-whoop" }) as any;
    expect(r.error).toBe("span_too_wide");
  });
});
