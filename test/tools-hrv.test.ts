import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import { buildMirrorSqlite, buildNoopbakFrom } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { hrvSeries } from "../src/tools/granular.js";

// hrv_series (RMSSD from beat-to-beat R-R intervals) — own mirror/dataDir, same reasoning as
// tools-hr-dense.test.ts/tools-motion-dense.test.ts: hand-crafted RR rows with an exactly-computable
// RMSSD don't belong in the shared fixture's pinned counts.
const dataDir = path.join(process.cwd(), "test/.tmp/hrv");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;

// Four isolated hour-aligned windows (clear of every other fixture day/night, and of each other) —
// hour-aligned so floor(ts/300)*300 and floor(ts/60)*60 land exactly on the window start, keeping each
// block inside its own bucket boundary.
const DENSE_START = Math.floor(new Date("2026-06-20T04:00:00Z").getTime() / 1000); // exact-RMSSD series
const SPARSE_START = DENSE_START + 3600; // 05:00Z — too-few-beats bucket
const ARTIFACT_START = DENSE_START + 7200; // 06:00Z — clean series + one spliced-in artifact
const SPLIT_START = DENSE_START + 10800; // 07:00Z — long series, forces a multi-bucket split

// Alternating 800ms/850ms beats: every successive diff is exactly ±50ms, so RMSSD = sqrt(mean(50^2))
// = 50ms exactly regardless of n — a hand-verifiable series with no artifacts (50/800 = 6.25% and
// 50/850 = 5.88% deviation, both well under the 20% ectopic threshold, so nothing gets rejected).
// seq = beat index: guarantees the (deviceId, ts, rrMs, seq) PK never collides even when two beats
// round to the same integer-second ts (RR granularity is sub-second; ts is not — see rrIntervalsRange
// in src/mirror.ts).
function insertAlternatingSeries(raw: Database.Database, deviceId: string, startTs: number, n: number): void {
  const rr = raw.prepare("INSERT INTO rrInterval (deviceId,ts,rrMs,seq,synced) VALUES (?,?,?,?,?)");
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const rrMs = i % 2 === 0 ? 800 : 850;
    rr.run(deviceId, startTs + Math.floor(acc / 1000), rrMs, i, 0);
    acc += rrMs;
  }
}

beforeAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
  const srcSqlite = path.join(dataDir, "src.sqlite");
  buildMirrorSqlite(srcSqlite);
  const raw = new Database(srcSqlite);
  insertAlternatingSeries(raw, "my-whoop", DENSE_START, 40); // ~33s span, 1 bucket at 300s or 60s
  insertAlternatingSeries(raw, "my-whoop", SPARSE_START, 5); // well under the 20-beat floor
  insertAlternatingSeries(raw, "my-whoop", ARTIFACT_START, 40);
  // One out-of-range artifact (40ms, well below the 250ms floor) spliced into the middle of the clean
  // 40-beat run above — the range filter must drop it before the spike check ever sees it, leaving the
  // real 40 beats' successive diffs (and therefore RMSSD) untouched.
  raw.prepare("INSERT INTO rrInterval (deviceId,ts,rrMs,seq,synced) VALUES (?,?,?,?,?)").run("my-whoop", ARTIFACT_START + 15, 40, 999, 0);
  insertAlternatingSeries(raw, "my-whoop", SPLIT_START, 200); // ~165s span — crosses a 60s boundary
  raw.close();
  const zip = path.join(dataDir, "b.noopbak");
  buildNoopbakFrom(srcSqlite, zip);
  ingestNoopbak(fs.readFileSync(zip), cfg);
});

describe("hrv_series", () => {
  it("computes exact RMSSD/meanHr on a known alternating series", () => {
    const from = new Date(DENSE_START * 1000).toISOString();
    const to = new Date((DENSE_START + 250) * 1000).toISOString();
    const r = hrvSeries(cfg, { from, to, deviceId: "my-whoop", bucketSeconds: 300 }) as any;
    expect(r.buckets.length).toBe(1);
    const bucket = r.buckets[0];
    expect(bucket.n).toBe(40);
    expect(bucket.rmssd).toBeCloseTo(50, 5); // sqrt(mean(50^2)) exactly
    expect(bucket.meanHr).toBeCloseTo(72.7, 1); // 60000 / 825
    expect(bucket.deviceId).toBe("my-whoop");
    expect(bucket.family).toBe("whoop");
  });

  it("splits a long series across multiple buckets at a narrower bucketSeconds", () => {
    const from = new Date(SPLIT_START * 1000).toISOString();
    const to = new Date((SPLIT_START + 250) * 1000).toISOString();
    const r = hrvSeries(cfg, { from, to, deviceId: "my-whoop", bucketSeconds: 60 }) as any;
    expect(r.buckets.length).toBeGreaterThan(1);
    const totalN = r.buckets.reduce((s: number, b: any) => s + b.n, 0);
    expect(totalN).toBe(200); // every beat lands in exactly one bucket, none dropped by bucketing
  });

  it("returns rmssd:null and meanHr:null (not fabricated) for a bucket under the clean-beat floor", () => {
    const from = new Date(SPARSE_START * 1000).toISOString();
    const to = new Date((SPARSE_START + 60) * 1000).toISOString();
    const r = hrvSeries(cfg, { from, to, deviceId: "my-whoop", bucketSeconds: 300 }) as any;
    expect(r.buckets.length).toBe(1);
    expect(r.buckets[0].n).toBe(5);
    expect(r.buckets[0].rmssd).toBeNull();
    expect(r.buckets[0].meanHr).toBeNull();
  });

  it("drops an out-of-range artifact without disturbing the surrounding clean RMSSD", () => {
    const from = new Date(ARTIFACT_START * 1000).toISOString();
    const to = new Date((ARTIFACT_START + 250) * 1000).toISOString();
    const r = hrvSeries(cfg, { from, to, deviceId: "my-whoop", bucketSeconds: 300 }) as any;
    expect(r.buckets.length).toBe(1);
    expect(r.buckets[0].n).toBe(40); // the spliced-in 41st row (40ms) was dropped by the range filter
    expect(r.buckets[0].rmssd).toBeCloseTo(50, 5);
  });

  it("flags rrAvailable:false for a range with no R-R data at all (Oura/pre-WHOOP)", () => {
    const r = hrvSeries(cfg, { from: "2026-06-10", to: "2026-06-13", deviceId: "oura-api" }) as any;
    expect(r.buckets).toEqual([]);
    expect(r.rrAvailable).toBe(false);
  });

  it("rejects a >7-day span", () => {
    expect((hrvSeries(cfg, { from: "2026-06-01", to: "2026-06-13" }) as any).error).toBe("span_too_wide");
  });

  it("reports notIngested before first ingest", () => {
    const emptyDir = path.join(process.cwd(), "test/.tmp/hrv-empty");
    fs.rmSync(emptyDir, { recursive: true, force: true }); fs.mkdirSync(emptyDir, { recursive: true });
    const emptyCfg = { dataDir: emptyDir, mirrorPath: path.join(emptyDir, "mirror.sqlite"), serverDbPath: path.join(emptyDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
    const r = hrvSeries(emptyCfg, { from: "2026-06-10", to: "2026-06-13" }) as any;
    expect(r.buckets).toEqual([]);
    expect(r.notIngested).toBe(true);
  });
});
