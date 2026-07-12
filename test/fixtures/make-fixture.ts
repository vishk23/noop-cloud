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
  wo.run("oura-api", tsOf("2026-06-11", 17), "walking", tsOf("2026-06-11", 17) + 2400, "oura", 2400, 180, 3000);

  const ms = db.prepare("INSERT INTO metricSeries VALUES (?,?,?,?)");
  for (const day of DAYS) {
    ms.run("oura-api", day, "ref_sleep_score", 82);
    ms.run("oura-api", day, "oura_readiness", 78);
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
