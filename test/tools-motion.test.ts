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
});
