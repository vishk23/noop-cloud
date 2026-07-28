import Database from "better-sqlite3";
import AdmZip from "adm-zip";
import fs from "node:fs";

const DAYS = ["2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13"];
const tsOf = (day: string, h = 3) => Math.floor(new Date(`${day}T${String(h).padStart(2, "0")}:00:00Z`).getTime() / 1000);

export function buildMirrorSqlite(target: string): void {
  if (fs.existsSync(target)) fs.rmSync(target);
  const db = new Database(target);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE grdb_migrations (identifier TEXT PRIMARY KEY);
    CREATE TABLE hrSample (deviceId TEXT, ts INTEGER, bpm INTEGER, PRIMARY KEY(deviceId, ts));
    -- The v26 optical per-second HR estimate. Real column types from the phone's GRDB migration: bpm and
    -- conf are REAL there, not INTEGER, which is why hr_series CASTs the union leg to the Int bpm domain.
    CREATE TABLE ppgHrSample (deviceId TEXT, ts INTEGER, bpm REAL, conf REAL, PRIMARY KEY(deviceId, ts));
    CREATE TABLE rrInterval (deviceId TEXT, ts INTEGER, rrMs INTEGER, seq INTEGER DEFAULT 0,
      synced INTEGER DEFAULT 0, PRIMARY KEY(deviceId, ts, rrMs, seq));
    CREATE TABLE dailyMetric (deviceId TEXT, day TEXT, totalSleepMin INTEGER, efficiency REAL,
      restingHr REAL, avgHrv REAL, recovery REAL, strain REAL, spo2Pct REAL, skinTempDevC REAL,
      respRateBpm REAL, steps INTEGER, activeKcalEst REAL, PRIMARY KEY(deviceId, day));
    CREATE TABLE sleepSession (deviceId TEXT, startTs INTEGER, endTs INTEGER, efficiency REAL,
      restingHr REAL, avgHrv REAL, stagesJSON TEXT, userEdited INTEGER DEFAULT 0,
      startTsAdjusted INTEGER, PRIMARY KEY(deviceId, startTs));
    CREATE TABLE workout (deviceId TEXT, startTs INTEGER, sport TEXT, endTs INTEGER, source TEXT,
      durationS REAL, energyKcal REAL, distanceM REAL, PRIMARY KEY(deviceId, startTs, sport));
    CREATE TABLE metricSeries (deviceId TEXT, day TEXT, key TEXT, value REAL, PRIMARY KEY(deviceId, day, key));
    CREATE TABLE appleDaily (deviceId TEXT, day TEXT, steps INTEGER, restingHr REAL, PRIMARY KEY(deviceId, day));
    CREATE TABLE pairedDevice (id TEXT PRIMARY KEY, brand TEXT, model TEXT, sourceKind TEXT);
    CREATE TABLE stepSample (deviceId TEXT, ts INTEGER, counter INTEGER, activityClass INTEGER, PRIMARY KEY(deviceId, ts));
    CREATE TABLE gravitySample (deviceId TEXT, ts INTEGER, x DOUBLE, y DOUBLE, z DOUBLE, synced INTEGER DEFAULT 0, PRIMARY KEY(deviceId, ts));
    CREATE TABLE appleStepHour (deviceId TEXT, ts INTEGER, steps INTEGER, PRIMARY KEY(deviceId, ts));
  `);
  db.prepare("INSERT INTO grdb_migrations VALUES (?)").run("v25-oura-raw");
  const pd = db.prepare("INSERT INTO pairedDevice VALUES (?,?,?,?)");
  pd.run("my-whoop", "WHOOP", "5.0", "strap");
  pd.run("my-whoop-noop", "WHOOP", "5.0", "derived");
  pd.run("oura-api", "Oura", "Oura (cloud)", "cloudImport");
  pd.run("apple-health", "Apple", "Apple Health", "appleHealth");

  const dm = db.prepare(`INSERT INTO dailyMetric
    (deviceId,day,totalSleepMin,efficiency,restingHr,avgHrv,recovery,strain,spo2Pct,skinTempDevC,respRateBpm,steps,activeKcalEst)
    VALUES (@deviceId,@day,@totalSleepMin,@efficiency,@restingHr,@avgHrv,@recovery,@strain,@spo2Pct,@skinTempDevC,@respRateBpm,@steps,@activeKcalEst)`);
  const base = (deviceId: string, day: string, o: Partial<any>) => ({
    deviceId, day, totalSleepMin: 420, efficiency: 90, restingHr: 52, avgHrv: 65, recovery: null,
    strain: null, spo2Pct: 97, skinTempDevC: -0.1, respRateBpm: 14.5, steps: 8000, activeKcalEst: 500, ...o,
  });
  for (const day of DAYS) {
    // WHOOP is the scored source: recovery/strain present.
    dm.run(base("my-whoop", day, { restingHr: 51, avgHrv: 70, recovery: 66, strain: 12.5 }));
    // WHOOP derived lineage — same family, second deviceId, scores only (no raw vitals).
    // Mirrors real mirrors where e.g. "my-whoop-noop" carries recovery/strain while the
    // strap device "my-whoop" carries sleep/steps/HR — same-family, disjoint fields.
    dm.run(base("my-whoop-noop", day, {
      totalSleepMin: null, efficiency: null, restingHr: null, avgHrv: null,
      recovery: 58, strain: 11.0, spo2Pct: null, skinTempDevC: null, respRateBpm: null,
      steps: null, activeKcalEst: null,
    }));
    // Oura cloud: honest data, recovery/strain null; slightly different RHR/HRV.
    dm.run(base("oura-api", day, { restingHr: 53, avgHrv: 62 }));
    // Apple: steps only-ish.
    dm.run(base("apple-health", day, { restingHr: 54, avgHrv: null, steps: 8200 }));
  }
  const ss = db.prepare(`INSERT INTO sleepSession
    (deviceId,startTs,endTs,efficiency,restingHr,avgHrv,stagesJSON,userEdited,startTsAdjusted)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const day of DAYS) {
    ss.run("my-whoop", tsOf(day, 3), tsOf(day, 3) + 25200, 90, 51, 70, null, 0, null);
    ss.run("oura-api", tsOf(day, 3) + 60, tsOf(day, 3) + 25000, 88, 53, 62, null, 0, null);
  }
  const wo = db.prepare(`INSERT INTO workout (deviceId,startTs,sport,endTs,source,durationS,energyKcal,distanceM)
    VALUES (?,?,?,?,?,?,?,?)`);
  wo.run("my-whoop", tsOf("2026-06-12", 18), "running", tsOf("2026-06-12", 18) + 1800, "whoop", 1800, 320, 5000);
  wo.run("oura-api", tsOf("2026-06-11", 17), "walking", tsOf("2026-06-11", 17) + 2400, "oura", 2000, 180, 3000);

  const ms = db.prepare("INSERT INTO metricSeries VALUES (?,?,?,?)");
  for (const day of DAYS) {
    ms.run("oura-api", day, "ref_sleep_score", 82);
    ms.run("oura-api", day, "oura_readiness", 78);
    // Real phone behavior: Apple Health import writes steps to metricSeries+appleDaily, NOT
    // dailyMetric — this fixture's apple-health dailyMetric row above (steps: 8200) is an
    // intentional pin for the precedence test, so this 9100 value stays shadowed. See
    // compareSources' metricSeries fallback in src/tools/compare.ts.
    ms.run("apple-health", day, "steps", 9100);
    // vo2max has no dailyMetric column at all (for any family) — pure-fallback proof, and with a
    // second family below it also exercises spreadPct math over fallback-only values.
    ms.run("apple-health", day, "vo2max", 41);
    ms.run("my-whoop", day, "vo2max", 45);
  }
  const hr = db.prepare("INSERT INTO hrSample VALUES (?,?,?)");
  for (const day of DAYS) for (let i = 0; i < 5; i++) hr.run("oura-api", tsOf(day, 3) + i * 300, 55 + i);

  // Granular night data (2026-06-13, my-whoop): stages on the sleep row + 5-min HR across the night.
  const night = tsOf("2026-06-13", 3);
  const stages = JSON.stringify([
    { start: night, end: night + 3600, stage: "light" },
    { start: night + 3600, end: night + 10800, stage: "deep" },
    { start: night + 10800, end: night + 18000, stage: "rem" },
    { start: night + 18000, end: night + 25200, stage: "light" },
  ]);
  db.prepare("UPDATE sleepSession SET stagesJSON = ? WHERE deviceId = 'my-whoop' AND startTs = ?").run(stages, night);
  for (let t = night; t <= night + 25200; t += 300) hr.run("my-whoop", t, 46 + Math.round(8 * Math.abs(Math.sin(t / 3000))));

  // R-R intervals for the same night (my-whoop only — Oura's API never exposes beat-to-beat data, so
  // rrInterval stays empty for oura-api/apple-health across this whole fixture; see hrv_series in
  // src/tools/granular.ts and the data_freshness `tables` union in src/mirror.ts's sources()). A short
  // alternating 800/850ms burst, one row per second so the composite PK can't collide — just enough
  // presence for data_freshness/sources() to see "rrInterval" under my-whoop's tables. Precise
  // RMSSD-math/bucketing/sparse-bucket/artifact-filter fixtures live in their own dedicated mirror
  // (test/tools-hrv.test.ts), same pattern as tools-hr-dense.test.ts/tools-motion-dense.test.ts.
  const rr = db.prepare("INSERT INTO rrInterval (deviceId,ts,rrMs,seq,synced) VALUES (?,?,?,?,?)");
  for (let i = 0; i < 24; i++) rr.run("my-whoop", night + i, i % 2 === 0 ? 800 : 850, 0, 0);

  // Motion evidence for the same night (my-whoop), CoreMotion/WHOOP-shaped: wrist posture (gravity)
  // is stable 03:00-05:00Z aside from a 03:30-03:40Z posture-change blip (a "stayed in bed" night).
  // stepSample.counter is the real step_motion_counter@57 column — a CUMULATIVE u16 counter, NOT a
  // per-sample step count (see stepDeltas() in src/tools/granular.ts) — so a baseline sample plus
  // three post-walk samples give wrap-aware deltas of 20/30/25 (sum 75), landing just after the
  // sleepSession's real end (night+25200 = 10:00Z, set above) so an in-session step sum is
  // legitimately 0: the walk happens after wake. Both tables are new and absent from any mirror
  // ingested before this feature shipped.
  const grav = db.prepare("INSERT INTO gravitySample VALUES (?,?,?,?,?,?)");
  const BLIP_START = night + 1800, BLIP_END = night + 2400; // 03:30–03:40Z
  for (let t = night; t <= night + 7200; t += 5) { // 03:00–05:00Z, ~1 row/5s
    const blip = t >= BLIP_START && t < BLIP_END;
    grav.run("my-whoop", t, blip ? 0.9 : 0.0, 0.0, blip ? 0.2 : 1.0, 0);
  }
  const step = db.prepare("INSERT INTO stepSample VALUES (?,?,?,?)");
  const wake = night + 25200; // sleepSession endTs for my-whoop on this night
  step.run("my-whoop", wake + 240, 1000, null); // 10:04Z baseline — no predecessor, contributes 0
  step.run("my-whoop", wake + 300, 1020, 1);    // 10:05Z, delta 20 (activityClass 1 = walk)
  step.run("my-whoop", wake + 360, 1050, 1);    // 10:06Z, delta 30
  step.run("my-whoop", wake + 420, 1075, 1);    // 10:07Z, delta 25

  // iPhone hourly steps overlay (appleStepHour, NOOP commit d47525ea): idle overnight then a walk
  // starting 07:00Z, same 2026-06-13 night as the WHOOP motion fixture above — lets motion_series
  // tests overlay phone-vs-strap recording windows on one night. New table, absent from any mirror
  // ingested before this feature shipped (same hasTable tolerance as stepSample/gravitySample). No
  // existing pin counts these rows.
  const appleHour = db.prepare("INSERT INTO appleStepHour VALUES (?,?,?)");
  const APPLE_HOURLY_STEPS = [0, 0, 0, 0, 120, 900, 1500, 400]; // 03:00Z..10:00Z, walk starts 07:00Z
  APPLE_HOURLY_STEPS.forEach((steps, i) => appleHour.run("apple-health", night + i * 3600, steps));

  // Fractional-offset timezone test: rows at HH:30:00Z (simulating local-hour-anchored times in
  // timezones like IST/UTC+5:30). The bucket ts should preserve the original row.ts exactly,
  // not floor it to the nearest UTC hour boundary.
  const fracDay = tsOf("2026-06-12", 0); // 2026-06-12 00:00:00Z
  appleHour.run("apple-health", fracDay + 1800, 50);   // 00:30:00Z (local hour boundary in UTC+5:30)
  appleHour.run("apple-health", fracDay + 5400, 75);   // 01:30:00Z
  appleHour.run("apple-health", fracDay + 9000, 100);  // 02:30:00Z

  // Isolated wrap/gap fixture for stepDeltas() (2026-06-10 noon — clear of every other motion-tool
  // test window): a real u16 wrap (65530 -> 10, delta 16), a >=512 "gap" jump that MUST be dropped
  // (10 -> 20000, delta 19990 — a sync-session boundary/reboot, not real motion), then a real delta
  // after it (20000 -> 20015, delta 15). Wrap-aware, gap-filtered sum = 16 + 15 = 31.
  const wrapDay = tsOf("2026-06-10", 12);
  step.run("my-whoop", wrapDay, 65530, null);
  step.run("my-whoop", wrapDay + 60, 10, null);
  step.run("my-whoop", wrapDay + 120, 20000, null);
  step.run("my-whoop", wrapDay + 180, 20015, null);

  // Activity-class (#316/@63, 0=still/1=walk/2=run) diversity fixture, INSIDE the plain 2026-06-11
  // my-whoop sleepSession bounds (03:00-10:00Z, no stages/HR/gravity of its own) so it exercises both
  // sleep_detail.motion and motion_series against the same rows. One baseline (no predecessor, class
  // null, contributes 0) then one delta per class: still=10, walk=30, run=50, unclassified=5 — sum 95,
  // matching `steps`. All four offsets land in one 300s bucket (04:00:00-04:04:00Z).
  const actBase = tsOf("2026-06-11", 3) + 3600; // 04:00Z, inside [03:00Z, 10:00Z)
  step.run("my-whoop", actBase, 5000, null);      // 04:00Z baseline
  step.run("my-whoop", actBase + 60, 5010, 0);    // 04:01Z, delta 10, still
  step.run("my-whoop", actBase + 120, 5040, 1);   // 04:02Z, delta 30, walk
  step.run("my-whoop", actBase + 180, 5090, 2);   // 04:03Z, delta 50, run
  step.run("my-whoop", actBase + 240, 5095, null);// 04:04Z, delta 5, unclassified

  db.close();
}

export function buildNoopbakFrom(sqlitePath: string, zipPath: string): void {
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  const zip = new AdmZip();
  zip.addFile("noop-backup.sqlite", fs.readFileSync(sqlitePath)); // DB entry FIRST
  zip.writeZip(zipPath);
}

export function buildNoopbak(zipPath: string): void {
  const tmpSqlite = zipPath + ".src.sqlite";
  buildMirrorSqlite(tmpSqlite);
  buildNoopbakFrom(tmpSqlite, zipPath);
  fs.rmSync(tmpSqlite);
  for (const ext of ["-wal", "-shm"]) if (fs.existsSync(tmpSqlite + ext)) fs.rmSync(tmpSqlite + ext);
}
