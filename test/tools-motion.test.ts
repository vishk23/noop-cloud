import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { motionSeries, sleepDetail } from "../src/tools/granular.js";

const dataDir = path.join(process.cwd(), "test/.tmp/motion");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const NIGHT = Math.floor(new Date("2026-06-13T03:00:00Z").getTime() / 1000);
const WAKE = NIGHT + 25200; // sleepSession endTs for my-whoop on this night (10:00Z)

beforeAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), cfg); });

describe("motion_series", () => {
  it("buckets posture (gravity) averages across the stable night window, with family + n", () => {
    const r = motionSeries(cfg, { from: "2026-06-13T03:00:00Z", to: "2026-06-13T05:00:00Z", deviceId: "my-whoop", bucketSeconds: 300 }) as any;
    expect(r.buckets.length).toBeGreaterThanOrEqual(24); // 2h / 5min
    const first = r.buckets[0];
    expect(first.deviceId).toBe("my-whoop");
    expect(first.family).toBe("whoop");
    expect(first.steps).toBe(0); // no step rows during the night
    expect(first.postureX).toBeCloseTo(0.0, 2);
    expect(first.postureZ).toBeCloseTo(1.0, 2);
    expect(first.n).toBeGreaterThan(0);
  });

  it("the 03:30-03:40Z blip bucket reports the shifted posture", () => {
    const r = motionSeries(cfg, { from: "2026-06-13T03:00:00Z", to: "2026-06-13T05:00:00Z", deviceId: "my-whoop", bucketSeconds: 300 }) as any;
    const blip = r.buckets.find((b: any) => b.ts === NIGHT + 1800);
    expect(blip).toBeDefined();
    expect(blip.postureX).toBeCloseTo(0.9, 2);
    expect(blip.postureZ).toBeCloseTo(0.2, 2);
    expect(blip.postureVar).toBe(0); // constant orientation within the bucket -> zero range
  });

  it("sums the post-wake walk steps as wrap-aware counter deltas, not raw counter values", () => {
    const r = motionSeries(cfg, { from: "2026-06-13T10:00:00Z", to: "2026-06-13T10:15:00Z", deviceId: "my-whoop", bucketSeconds: 300 }) as any;
    const totalSteps = r.buckets.reduce((s: number, b: any) => s + b.steps, 0);
    expect(totalSteps).toBe(75); // deltas 20 + 30 + 25 (counter values are ~1000-1075, nowhere near 75)
    expect(r.buckets.every((b: any) => b.postureX === undefined)).toBe(true); // no gravity rows in this window
    // the baseline sample (10:04Z) is its own bucket: present (n=1, raw-row evidence) but contributes
    // 0 steps since it has no in-window predecessor to delta against.
    const baselineBucket = r.buckets.find((b: any) => b.ts === WAKE + 240 - ((WAKE + 240) % 300));
    expect(baselineBucket.steps).toBe(0);
    expect(baselineBucket.n).toBe(1);
    // the three walk samples (10:05-10:07Z) land in one 5-min bucket carrying the full delta sum.
    const walkBucket = r.buckets.find((b: any) => b.ts === WAKE + 300);
    expect(walkBucket.steps).toBe(75);
    expect(walkBucket.n).toBe(3);
  });

  it("wrap-aware, gap-filtered delta sum: a real u16 wrap counts, a >=512 jump is dropped", () => {
    const r = motionSeries(cfg, { from: "2026-06-10T12:00:00Z", to: "2026-06-10T12:05:00Z", deviceId: "my-whoop", bucketSeconds: 600 }) as any;
    const totalSteps = r.buckets.reduce((s: number, b: any) => s + b.steps, 0);
    // 65530->10 wraps to a real delta of 16; 10->20000 is a >=512 gap, dropped entirely (would
    // otherwise contribute 19990 and dwarf everything else); 20000->20015 is a real delta of 15.
    expect(totalSteps).toBe(31);
  });

  it("defaults bucketSeconds to 300 and omits buckets with neither steps nor gravity", () => {
    const r = motionSeries(cfg, { from: "2026-06-13T06:00:00Z", to: "2026-06-13T07:00:00Z", deviceId: "my-whoop" }) as any;
    expect(r.buckets).toEqual([]); // no motion rows seeded in this stretch of the night
  });

  it("rejects a >7 day span", () => {
    expect((motionSeries(cfg, { from: "2026-06-01", to: "2026-06-13" }) as any).error).toBe("span_too_wide");
  });

  it("returns notIngested: true before first ingest", () => {
    const emptyDir = path.join(process.cwd(), "test/.tmp/motion-empty");
    fs.rmSync(emptyDir, { recursive: true, force: true }); fs.mkdirSync(emptyDir, { recursive: true });
    const cfg2 = { dataDir: emptyDir, mirrorPath: path.join(emptyDir, "mirror.sqlite"), serverDbPath: path.join(emptyDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
    const r = motionSeries(cfg2, { from: "2026-06-13", to: "2026-06-13" }) as any;
    expect(r.buckets).toEqual([]);
    expect(r.notIngested).toBe(true);
  });

  it("splits wrap-aware deltas into walk/run/still/unclassified ticks by the class of the ENDING sample", () => {
    const actBase = Math.floor(new Date("2026-06-11T04:00:00Z").getTime() / 1000);
    const r = motionSeries(cfg, { from: "2026-06-11T04:00:00Z", to: "2026-06-11T04:05:00Z", deviceId: "my-whoop", bucketSeconds: 300 }) as any;
    expect(r.buckets.length).toBe(1);
    const bucket = r.buckets[0];
    expect(bucket.ts).toBe(actBase);
    expect(bucket.steps).toBe(95); // 10 (still) + 30 (walk) + 50 (run) + 5 (unclassified)
    expect(bucket.stillTicks).toBe(10);
    expect(bucket.walkTicks).toBe(30);
    expect(bucket.runTicks).toBe(50);
    expect(bucket.unclassifiedTicks).toBe(5);
    expect(bucket.stillTicks + bucket.walkTicks + bucket.runTicks + bucket.unclassifiedTicks).toBe(bucket.steps);
    expect(bucket.n).toBe(5); // baseline + 4 classed samples, all raw-row evidence
  });

  it("tolerates a mirror missing stepSample/gravitySample (pre-feature mirror) — empty, not throw", () => {
    const oldDir = path.join(process.cwd(), "test/.tmp/motion-old");
    fs.rmSync(oldDir, { recursive: true, force: true }); fs.mkdirSync(oldDir, { recursive: true });
    const cfgOld = { dataDir: oldDir, mirrorPath: path.join(oldDir, "mirror.sqlite"), serverDbPath: path.join(oldDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
    const z = path.join(oldDir, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), cfgOld);
    const raw = new Database(cfgOld.mirrorPath);
    raw.exec("DROP TABLE stepSample; DROP TABLE gravitySample;");
    raw.close();

    expect(() => motionSeries(cfgOld, { from: "2026-06-13T03:00:00Z", to: "2026-06-13T05:00:00Z" })).not.toThrow();
    const r = motionSeries(cfgOld, { from: "2026-06-13T03:00:00Z", to: "2026-06-13T05:00:00Z" }) as any;
    expect(r.buckets).toEqual([]);
    expect(r.notIngested).toBeUndefined(); // mirror IS ingested, just missing these two tables

    expect(() => sleepDetail(cfgOld, { deviceId: "my-whoop", startTs: NIGHT })).not.toThrow();
    expect((sleepDetail(cfgOld, { deviceId: "my-whoop", startTs: NIGHT }) as any).motion).toBeNull();
  });
});

describe("motion_series apple-health hourly overlay (appleStepHour)", () => {
  it("includes apple-health hourly buckets alongside strap buckets when unfiltered at hourly granularity", () => {
    const r = motionSeries(cfg, { from: "2026-06-13T03:00:00Z", to: "2026-06-13T10:00:00Z", bucketSeconds: 3600 }) as any;
    const appleBuckets = r.buckets.filter((b: any) => b.deviceId === "apple-health");
    expect(appleBuckets.length).toBe(8); // 03:00Z..10:00Z inclusive, one appleStepHour row per hour
    expect(appleBuckets.every((b: any) => b.family === "apple")).toBe(true);
    expect(appleBuckets.map((b: any) => b.steps)).toEqual([0, 0, 0, 0, 120, 900, 1500, 400]);
    // apple rows carry neither posture (gravity) nor activity-class evidence.
    expect(appleBuckets.every((b: any) => b.postureX === undefined)).toBe(true);
    expect(appleBuckets.every((b: any) => b.walkTicks === undefined)).toBe(true);
    // strap (my-whoop) gravity buckets from the same night are still present, untouched by the overlay.
    const strapBuckets = r.buckets.filter((b: any) => b.deviceId === "my-whoop");
    expect(strapBuckets.length).toBeGreaterThan(0);
    expect(r.appleOmitted).toBeUndefined();
  });

  it("rejects a sub-hour bucket when explicitly filtered to apple-health", () => {
    const r = motionSeries(cfg, { from: "2026-06-13T03:00:00Z", to: "2026-06-13T10:00:00Z", deviceId: "apple-health", bucketSeconds: 120 }) as any;
    expect(r.error).toBe("apple_hourly_min_bucket");
    expect(r.hint).toBe("appleStepHour data is hourly; use bucketSeconds >= 3600");
    expect(r.buckets).toBeUndefined();
  });

  it("omits apple rows and flags appleOmitted when unfiltered with a sub-hour bucket (strap stays fine-grained)", () => {
    const r = motionSeries(cfg, { from: "2026-06-13T03:00:00Z", to: "2026-06-13T10:00:00Z", bucketSeconds: 120 }) as any;
    expect(r.appleOmitted).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.buckets.some((b: any) => b.deviceId === "apple-health")).toBe(false);
  });

  it("tolerates a mirror missing appleStepHour (pre-feature mirror) at hourly granularity — no throw, no apple rows", () => {
    const oldDir = path.join(process.cwd(), "test/.tmp/motion-old-apple");
    fs.rmSync(oldDir, { recursive: true, force: true }); fs.mkdirSync(oldDir, { recursive: true });
    const cfgOld = { dataDir: oldDir, mirrorPath: path.join(oldDir, "mirror.sqlite"), serverDbPath: path.join(oldDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
    const z = path.join(oldDir, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), cfgOld);
    const raw = new Database(cfgOld.mirrorPath);
    raw.exec("DROP TABLE appleStepHour;");
    raw.close();

    expect(() => motionSeries(cfgOld, { from: "2026-06-13T03:00:00Z", to: "2026-06-13T10:00:00Z", bucketSeconds: 3600 })).not.toThrow();
    const r = motionSeries(cfgOld, { from: "2026-06-13T03:00:00Z", to: "2026-06-13T10:00:00Z", bucketSeconds: 3600 }) as any;
    expect(r.buckets.some((b: any) => b.deviceId === "apple-health")).toBe(false);
    expect(r.appleOmitted).toBeUndefined(); // table absence isn't the same as the bucket-size omission signal
  });

  it("preserves fractional-offset local-hour-anchored ts (e.g. IST 00:30Z) without re-flooring to UTC grid", () => {
    // Fractional-offset timezones (IST UTC+5:30, Nepal UTC+5:45, etc.) encode local hour boundaries
    // at non-UTC-hour-aligned timestamps. The bucket ts should preserve the original row.ts exactly,
    // not recompute it via Math.floor(row.ts / b) * b, which would shift it to the nearest UTC hour.
    const base = Math.floor(new Date("2026-06-12T00:00:00Z").getTime() / 1000);
    const r = motionSeries(cfg, { from: "2026-06-12T00:00:00Z", to: "2026-06-12T03:00:00Z", bucketSeconds: 3600 }) as any;
    const fracBuckets = r.buckets.filter((b: any) => b.deviceId === "apple-health" && b.ts >= base + 1800);
    expect(fracBuckets.length).toBe(3); // 00:30:00Z, 01:30:00Z, 02:30:00Z
    // Each bucket ts should match the original appleStepHour row.ts exactly, not floored to UTC hour boundary.
    expect(fracBuckets[0].ts).toBe(base + 1800);   // 00:30:00Z, not 00:00:00Z
    expect(fracBuckets[1].ts).toBe(base + 5400);   // 01:30:00Z, not 01:00:00Z
    expect(fracBuckets[2].ts).toBe(base + 9000);   // 02:30:00Z, not 02:00:00Z
    // Values are correct regardless (only the label drifted).
    expect(fracBuckets.map((b: any) => b.steps)).toEqual([50, 75, 100]);
  });
});

describe("sleep_detail motion evidence", () => {
  it("reports 0 in-session steps (the walk lands after the recorded wake) and >=1 posture change", () => {
    const r = sleepDetail(cfg, { deviceId: "my-whoop", startTs: NIGHT }) as any;
    expect(r.motion).not.toBeNull();
    expect(r.motion.steps).toBe(0);
    expect(r.motion.postureChanges).toBeGreaterThanOrEqual(1);
    // sanity: the walk steps genuinely sit outside [session.startTs, session.endTs]
    expect(WAKE).toBe(r.session.endTs);
  });

  it("falls back to any device's raw motion stream when the session's own device has none (real mirrors split scored-session vs raw-stream deviceId, same reason hrDuringSleep already falls back)", () => {
    // oura-api has its own sleepSession row this night but ZERO stepSample/gravitySample rows of its
    // own — every motion row in the fixture is tagged "my-whoop". Without the fallback this would
    // silently read as "no motion" instead of finding my-whoop's overlapping evidence.
    const ouraStart = NIGHT + 60;
    const r = sleepDetail(cfg, { deviceId: "oura-api", startTs: ouraStart }) as any;
    expect(r.session.deviceId).toBe("oura-api");
    expect(r.motion).not.toBeNull();
    expect(r.motion.postureChanges).toBeGreaterThanOrEqual(1); // the 03:30 blip, borrowed from my-whoop
  });

  it("reports the walk/run/still/unclassified tick split for a session with classed step samples, no truncation", () => {
    const day11 = Math.floor(new Date("2026-06-11T03:00:00Z").getTime() / 1000);
    const r = sleepDetail(cfg, { deviceId: "my-whoop", startTs: day11 }) as any;
    expect(r.motion).not.toBeNull();
    expect(r.motion.steps).toBe(95);
    expect(r.motion.stillTicks).toBe(10);
    expect(r.motion.walkTicks).toBe(30);
    expect(r.motion.runTicks).toBe(50);
    expect(r.motion.unclassifiedTicks).toBe(5);
    expect(r.motion.postureChanges).toBe(0); // no gravity rows seeded for this session
    expect(r.motion.truncated).toBeUndefined();
  });
});
