import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { imuCoverage } from "../src/tools/granular.js";

// imu_coverage reads the WhoopStore v28 `imuActivity` table (one row per second). Three mirrors here,
// because the tool's three distinct "empty" answers are the point and must not collapse into one:
//   cfg      — table present, rows present (the real cases)
//   emptyCfg — table present, ZERO rows: build supports capture, nothing was ever banked
//   bareCfg  — NO table: the uploading phone build predates the migration entirely
//
// The shape of the main fixture is modelled on VK's live mirror, where the whole table is a single
// ~58-minute run with a 560 s dropout in the middle — 2945 seconds banked across a 3506-second span.
const dataDir = path.join(process.cwd(), "test/.tmp/imucov");
const emptyDir = path.join(process.cwd(), "test/.tmp/imucov-empty");
const bareDir = path.join(process.cwd(), "test/.tmp/imucov-bare");
const mk = (d: string) => ({ dataDir: d, mirrorPath: path.join(d, "mirror.sqlite"), serverDbPath: path.join(d, "server.sqlite"), maxIngestBytes: 262_144_000 } as any);
const cfg = mk(dataDir), emptyCfg = mk(emptyDir), bareCfg = mk(bareDir);
const T0 = Math.floor(new Date("2026-06-13T12:00:00Z").getTime() / 1000);
const DDL = `CREATE TABLE IF NOT EXISTS imuActivity (deviceId TEXT NOT NULL, ts INTEGER NOT NULL, accelEnergyG DOUBLE NOT NULL, gyroEnergyDps DOUBLE NOT NULL, jerkRms DOUBLE NOT NULL, cadenceHz DOUBLE, cadenceStrength DOUBLE NOT NULL, sampleCount INTEGER NOT NULL, PRIMARY KEY(deviceId, ts));`;

// sampleCount is an OVERLAPPING WINDOW size, not this second's own samples. The producer
// (StrandAnalytics.ImuActivityIngest) computes each row's features over a TRAILING window of up to
// windowSeconds=6 CONTIGUOUS 1 s buffers ending at that second, and stores that whole window's sample
// total (ImuFeatureExtractor's `n`). So a steady 100 Hz run reads 100,200,300,400,500,600,600,… and
// RESETS to 100 after any hole, because a ts discontinuity restarts the walk-back. Every fixture row
// below is generated through this helper rather than a flat constant: a flat sampleCount would quietly
// license summing the column, and summing overlapping windows counts each raw sample up to 6x.
const WINDOW_S = 6, RATE_HZ = 100;
const winSamples = (secondsSinceReset: number) => Math.min(secondsSinceReset + 1, WINDOW_S) * RATE_HZ;

beforeAll(() => {
  for (const [d, c] of [[dataDir, cfg], [emptyDir, emptyCfg], [bareDir, bareCfg]] as const) {
    fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
    const z = path.join(d, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), c);
  }
  // Table but no rows: capture-capable build, nothing banked.
  const edb = new Database(emptyCfg.mirrorPath); edb.exec(DDL); edb.close();

  const db = new Database(cfg.mirrorPath);
  db.exec(DDL);
  const ins = db.prepare("INSERT INTO imuActivity VALUES (?,?,?,?,?,?,?,?)");
  // Run A: 100 contiguous seconds, rhythmic throughout (a walk) — a clean, 100%-covered capture.
  // sampleCount ramps 100→600 over the first 6 s and then holds: the real producer shape.
  for (let i = 0; i < 100; i++) ins.run("my-whoop", T0 + i, 0.30, 40.0, 0.08, 1.8, 0.6, winSamples(i));
  // Run B: starts 600 s later (> the 60 s default gap, so it is a SEPARATE session). 50 seconds of
  // wall-clock span but only 47 rows (20 + 19 + 8): two internal holes, one of 1 s and one of 2 s.
  // This is the coverage<1 case — a run that dropped rows mid-capture. Each hole RESETS the producer's
  // trailing window, so sampleCount ramps from 100 again after it rather than holding at 600.
  const B = T0 + 700;
  for (let i = 0; i < 20; i++) ins.run("my-whoop", B + i, 0.01, 1.0, 0.005, null, 0.05, winSamples(i));   // still
  // hole: B+20 missing (1 s) — window resets
  for (let i = 21; i < 40; i++) ins.run("my-whoop", B + i, 0.05, 2.0, 0.006, null, 0.05, winSamples(i - 21));
  // hole: B+40, B+41 missing (2 s) — window resets again
  for (let i = 42; i < 50; i++) ins.run("my-whoop", B + i, 0.90, 3.0, 0.007, null, 0.05, winSamples(i - 42));  // peak accel
  // A different strap's run, overlapping run A in TIME — must never merge into it.
  for (let i = 0; i < 10; i++) ins.run("other-strap", T0 + i, 0.02, 1.0, 0.005, null, 0.05, winSamples(i));
  db.close();
});

describe("imu_coverage", () => {
  it("distinguishes a mirror with NO imuActivity table (build predates the migration)", () => {
    const r = imuCoverage(bareCfg, {}) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.sessions).toEqual([]);
    expect(r.hint).toMatch(/predates the WhoopStore v28-imu-activity migration/);
  });

  it("distinguishes an EMPTY imuActivity table (capture-capable, nothing banked)", () => {
    const r = imuCoverage(emptyCfg, {}) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.sessions).toEqual([]);
    expect(r.hint).toMatch(/EMPTY/);
    expect(r.hint).toMatch(/toggle was off/);
  });

  it("distinguishes 'none in YOUR range' and points at where the data actually is", () => {
    const r = imuCoverage(cfg, { from: "2026-06-01", to: "2026-06-02", deviceId: "my-whoop" }) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.hint).toMatch(/no IMU buffers in THIS range/);
    // The escape hatch: the caller learns where to look instead of guessing again.
    expect(r.dataExtent.firstTs).toBe(T0);
    expect(r.dataExtent.seconds).toBe(147); // 100 (run A) + 47 (run B) rows for my-whoop
  });

  it("with no from/to, anchors on the table's own extent and finds every run", () => {
    const r = imuCoverage(cfg, { deviceId: "my-whoop" }) as any;
    expect(r.notCaptured).toBeUndefined();
    expect(r.sessions).toHaveLength(2);
    expect(r.window.fromTs).toBe(T0);          // no guessed window needed
    expect(r.totals.sessions).toBe(2);
    expect(r.totals.seconds).toBe(147);
  });

  it("reports a clean run as 100% covered", () => {
    const r = imuCoverage(cfg, { deviceId: "my-whoop" }) as any;
    const a = r.sessions[0];
    expect(a.startTs).toBe(T0);
    expect(a.endTs).toBe(T0 + 99);
    expect(a.seconds).toBe(100);
    expect(a.spanSeconds).toBe(100);
    expect(a.coverage).toBe(1);
    expect(a.missingSeconds).toBe(0);
    expect(a.gaps).toBe(0);
    expect(a.rhythmicSeconds).toBe(100);       // a walk: cadence locked every second
    expect(a.start).toBe("2026-06-13T12:00:00.000Z");
  });

  it("surfaces a dropped-rows run as coverage < 1 with the holes measured", () => {
    const r = imuCoverage(cfg, { deviceId: "my-whoop" }) as any;
    const b = r.sessions[1];
    expect(b.seconds).toBe(47);
    expect(b.spanSeconds).toBe(50);            // 50 s of wall clock...
    expect(b.missingSeconds).toBe(3);          // ...with 3 s never banked
    expect(b.coverage).toBe(0.94);
    expect(b.gaps).toBe(2);                    // two separate holes
    expect(b.largestGapSeconds).toBe(2);       // the bigger one
    expect(b.rhythmicSeconds).toBe(0);         // still: no cadence lock all run
    expect(b.accelEnergyPeakG).toBe(0.9);
  });

  it("reports no sample COUNT at all — the producer's sampleCount is an overlapping window", () => {
    // The regression this guards: sampleCount is the size of a TRAILING 6 s window, so consecutive rows
    // re-count the same raw samples and summing the column inflates by ~6x. Run A is 100 s of 100 Hz
    // capture — 10 000 raw samples actually banked — but its sampleCounts sum to 58 500. There is no
    // honest sample total derivable here: the window size is not the second's own samples, and the
    // mirror never stores the sample RATE, so seconds*rate would be an invented number rather than a
    // measured one. So the tool reports none. `seconds` and `coverage` are the real answers, and
    // anything that needs the buffers themselves belongs in imu_series.
    const r = imuCoverage(cfg, {}) as any;
    expect(r.sessions).toHaveLength(3);
    for (const s of r.sessions) expect(s).not.toHaveProperty("samples");
    expect(r.totals).not.toHaveProperty("samples");
  });

  it("never rounds coverage up to a perfect 1 while seconds are missing", () => {
    // Regression, caught against VK's live mirror: a 2175-second run across a 2176-second span is
    // 0.99954, which round3 hands back as 1.0 — reporting a clean capture while missingSeconds said 1
    // and defeating the `coverage < 1` check this tool tells callers to make. Reproduced here at the
    // same ratio: 1 hole in a long run must still read as imperfect.
    const long = path.join(process.cwd(), "test/.tmp/imucov-long");
    fs.rmSync(long, { recursive: true, force: true }); fs.mkdirSync(long, { recursive: true });
    const c = mk(long);
    const z = path.join(long, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), c);
    const db = new Database(c.mirrorPath); db.exec(DDL);
    const ins = db.prepare("INSERT INTO imuActivity VALUES (?,?,?,?,?,?,?,?)");
    // 2176-second span, one single second missing in the middle — 2175 rows banked. The hole at i=1000
    // resets the producer's trailing window, so the ramp restarts at i=1001.
    for (let i = 0; i < 2176; i++) { if (i === 1000) continue; ins.run("my-whoop", T0 + i, 0.1, 1.0, 0.005, null, 0.05, winSamples(i < 1000 ? i : i - 1001)); }
    db.close();
    const r = imuCoverage(c, { deviceId: "my-whoop" }) as any;
    const s = r.sessions[0];
    expect(s.seconds).toBe(2175);
    expect(s.spanSeconds).toBe(2176);
    expect(s.missingSeconds).toBe(1);
    expect(s.coverage).toBe(0.999); // NOT 1 — the clamp, not the raw round
    expect(s.coverage).toBeLessThan(1);
  });

  it("splits runs on a silence longer than gapSeconds instead of bridging it", () => {
    const r = imuCoverage(cfg, { deviceId: "my-whoop" }) as any;
    // The 600 s hole between A and B is a dropout, not an internal gap: two honest runs.
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions[0].endTs).toBe(T0 + 99);
    expect(r.sessions[1].startTs).toBe(T0 + 700);
    expect(r.sessions[0].gaps).toBe(0);        // the 600 s is BETWEEN sessions, not inside one
  });

  it("honours a larger gapSeconds by merging the runs into one", () => {
    const r = imuCoverage(cfg, { deviceId: "my-whoop", gapSeconds: 900 }) as any;
    expect(r.sessions).toHaveLength(1);
    const s = r.sessions[0];
    expect(s.seconds).toBe(147);               // same rows...
    expect(s.spanSeconds).toBe(750);           // ...across a much longer span
    expect(s.coverage).toBe(0.196);            // so coverage collapses — the merge is visible, not hidden
    expect(s.largestGapSeconds).toBe(600);     // the dropout, now an internal hole
  });

  it("splits sessions per device even when their runs overlap in time", () => {
    const r = imuCoverage(cfg, {}) as any;
    expect(r.sessions).toHaveLength(3);
    const others = r.sessions.filter((s: any) => s.deviceId === "other-strap");
    expect(others).toHaveLength(1);
    expect(others[0].seconds).toBe(10);        // never merged into my-whoop's overlapping run A
  });

  it("totals cover every session and count distinct UTC days", () => {
    const r = imuCoverage(cfg, {}) as any;
    expect(r.totals.sessions).toBe(3);
    expect(r.totals.seconds).toBe(157);        // my-whoop 147 + other-strap 10 — every run, not just
                                               // the filtered device's
    expect(r.totals.days).toBe(1);
  });

  it("filters by deviceId", () => {
    const r = imuCoverage(cfg, { deviceId: "other-strap" }) as any;
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].family).toBe("whoop");
    expect(r.dataExtent.seconds).toBe(10);     // extent is scoped to the device too
  });

  it("rejects a span wider than 366 days", () => {
    const r = imuCoverage(cfg, { from: "2024-01-01", to: "2026-06-30" }) as any;
    expect(r.error).toBe("span_too_wide");
    expect(r.maxDays).toBe(366);
  });

  it("allows a window far wider than the 7-day series tools", () => {
    const r = imuCoverage(cfg, { from: "2026-01-01", to: "2026-06-30", deviceId: "my-whoop" }) as any;
    expect(r.error).toBeUndefined();
    expect(r.sessions).toHaveLength(2);
  });

  it("rejects an unparseable range", () => {
    const r = imuCoverage(cfg, { from: "not-a-date", to: "also-not" }) as any;
    expect(r.error).toBe("bad_range");
  });
});
