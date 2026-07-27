import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { hrSeries, sleepDetail } from "../src/tools/granular.js";

const dataDir = path.join(process.cwd(), "test/.tmp/granular");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const SLEEP_TS = Math.floor(new Date("2026-06-13T03:00:00Z").getTime() / 1000);

beforeAll(async () => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), cfg); });

describe("granular reads", () => {
  it("hr_series raw returns my-whoop night samples with family", () => {
    const r = hrSeries(cfg, { from: "2026-06-13T03:00:00Z", to: "2026-06-13T10:00:00Z", deviceId: "my-whoop" }) as any;
    expect(r.samples.length).toBeGreaterThanOrEqual(80); // 5-min cadence over 7h
    expect(r.samples[0].family).toBe("whoop");
  });
  it("hr_series buckets aggregate", () => {
    const r = hrSeries(cfg, { from: "2026-06-13T03:00:00Z", to: "2026-06-13T10:00:00Z", deviceId: "my-whoop", bucketSeconds: 3600 }) as any;
    expect(r.buckets.length).toBeGreaterThanOrEqual(6);
    expect(r.buckets[0]).toHaveProperty("avg");
  });
  it("hr_series rejects >7d span", () => {
    expect((hrSeries(cfg, { from: "2026-06-01", to: "2026-06-13" }) as any).error).toBe("span_too_wide");
  });
  it("sleep_detail returns stages + in-sleep HR", () => {
    const r = sleepDetail(cfg, { deviceId: "my-whoop", startTs: SLEEP_TS }) as any;
    expect(r.session.durationMin).toBeGreaterThan(0);
    expect(r.stages.length).toBeGreaterThanOrEqual(3);
    expect(r.hrDuringSleep.length).toBeGreaterThanOrEqual(80);
    // Sparse night (well under the 5000-sample decimation cap): untouched, no decimation flags.
    expect(r.hrDecimated).toBeUndefined();
    expect(r.hrStride).toBeUndefined();
    expect(r.hrTotalSamples).toBeUndefined();
  });
  it("sleep_detail notFound for a ghost session", () => {
    expect((sleepDetail(cfg, { deviceId: "my-whoop", startTs: 1 }) as any).notFound).toBe(true);
  });
});
