import Database from "better-sqlite3";

export type Family = "whoop" | "oura" | "apple";
export function sourceFamily(deviceId: string): Family {
  if (deviceId === "oura-api") return "oura";
  if (deviceId === "apple-health") return "apple";
  return "whoop";
}

export interface DailyMetricRow {
  deviceId: string; family: Family; day: string;
  totalSleepMin: number | null; efficiency: number | null; restingHr: number | null;
  avgHrv: number | null; recovery: number | null; strain: number | null; spo2Pct: number | null;
  skinTempDevC: number | null; respRateBpm: number | null; steps: number | null; activeKcalEst: number | null;
}
export interface SleepRow { deviceId: string; family: Family; startTs: number; endTs: number; efficiency: number | null; restingHr: number | null; avgHrv: number | null; userEdited: number; }
export interface WorkoutRow { deviceId: string; family: Family; startTs: number; endTs: number; sport: string; source: string | null; durationS: number | null; energyKcal: number | null; distanceM: number | null; }
export interface MetricPointRow { deviceId: string; family: Family; day: string; key: string; value: number; }
// Real column is `counter` (WHOOP step_motion_counter@57): a CUMULATIVE u16 running counter, not a
// per-sample step count — see countPostureChanges' sibling stepDeltas() in tools/granular.ts.
// activityClass is a nullable INTEGER enum (0=still, 1=walk, 2=run), added in a later migration.
export interface StepSampleRow { deviceId: string; ts: number; counter: number; activityClass: number | null; }
export interface GravitySampleRow { deviceId: string; ts: number; x: number; y: number; z: number; }
export interface RRIntervalRow { deviceId: string; ts: number; rrMs: number; }

const withFamily = <T extends { deviceId: string }>(r: T) => ({ ...r, family: sourceFamily(r.deviceId) });

export class Mirror {
  private db: Database.Database;
  constructor(path: string) { this.db = new Database(path, { readonly: true, fileMustExist: true }); }
  close(): void { this.db.close(); }

  // Union deviceIds across dailyMetric, sleepSession, hrSample, and rrInterval: a device that only
  // ever writes raw samples (e.g. a strap deviceId, whose scored daily rollups land under a separate
  // derived "-noop" deviceId) previously had no dailyMetric row and was invisible here even
  // though it holds real data. One cheap GROUP BY per table (each aggregated off that table's own
  // deviceId-prefixed primary key), unioned in JS; `tables` records which of the four a source
  // actually appears in — rrInterval's presence there is how a caller learns which deviceIds carry
  // beat-to-beat R-R data (WHOOP-only; see hrv_series in src/tools/granular.ts).
  sources() {
    const dm = this.db.prepare(`SELECT deviceId, MAX(day) AS maxDay FROM dailyMetric GROUP BY deviceId`).all() as { deviceId: string; maxDay: string | null }[];
    const ss = this.db.prepare(`SELECT deviceId, MAX(date(startTs, 'unixepoch')) AS maxDay FROM sleepSession GROUP BY deviceId`).all() as { deviceId: string; maxDay: string | null }[];
    const hr = this.db.prepare(`SELECT deviceId, MAX(date(ts, 'unixepoch')) AS maxDay FROM hrSample GROUP BY deviceId`).all() as { deviceId: string; maxDay: string | null }[];
    const rr = this.db.prepare(`SELECT deviceId, MAX(date(ts, 'unixepoch')) AS maxDay FROM rrInterval GROUP BY deviceId`).all() as { deviceId: string; maxDay: string | null }[];
    const byDevice = new Map<string, { tables: Set<string>; latestDay: string | null }>();
    const merge = (rows: { deviceId: string; maxDay: string | null }[], table: string) => {
      for (const r of rows) {
        const e = byDevice.get(r.deviceId) ?? { tables: new Set<string>(), latestDay: null };
        e.tables.add(table);
        if (r.maxDay && (!e.latestDay || r.maxDay > e.latestDay)) e.latestDay = r.maxDay;
        byDevice.set(r.deviceId, e);
      }
    };
    merge(dm, "dailyMetric"); merge(ss, "sleepSession"); merge(hr, "hrSample"); merge(rr, "rrInterval");
    const brandById = new Map((this.db.prepare("SELECT id, brand FROM pairedDevice").all() as { id: string; brand: string | null }[]).map((b) => [b.id, b.brand]));
    return [...byDevice.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([deviceId, e]) => ({ deviceId, family: sourceFamily(deviceId), brand: brandById.get(deviceId) ?? null, latestDay: e.latestDay, tables: [...e.tables].sort() }));
  }
  // PRAGMA-introspected dailyMetric columns minus the two identity columns — lets callers (and
  // data_freshness, see tools/core.ts) discover real column names instead of guessing (post-hoc
  // audit: a whole agent-run was wasted failing to find skinTempDevC because nothing listed the
  // valid names).
  dailyMetricColumns(): string[] {
    const cols = this.db.prepare("PRAGMA table_info(dailyMetric)").all() as { name: string }[];
    return cols.map((c) => c.name).filter((n) => n !== "deviceId" && n !== "day");
  }
  // DISTINCT metricSeries keys with a per-family row count, capped at `limit` keys (default 100).
  // Two-step (DISTINCT keys first, then aggregate only those) rather than one GROUP BY over the
  // whole table, so a mirror with many distinct keys doesn't force a full-table aggregate just to
  // return a capped list.
  metricSeriesKeyCounts(limit = 100): { key: string; counts: Partial<Record<Family, number>> }[] {
    const keys = (this.db.prepare("SELECT DISTINCT key FROM metricSeries ORDER BY key LIMIT ?").all(limit) as { key: string }[]).map((r) => r.key);
    if (!keys.length) return [];
    const placeholders = keys.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT key, deviceId, COUNT(*) AS n FROM metricSeries WHERE key IN (${placeholders}) GROUP BY key, deviceId`
    ).all(...keys) as { key: string; deviceId: string; n: number }[];
    const byKey = new Map<string, Partial<Record<Family, number>>>();
    for (const key of keys) byKey.set(key, {});
    for (const r of rows) {
      const counts = byKey.get(r.key)!;
      const fam = sourceFamily(r.deviceId);
      counts[fam] = (counts[fam] ?? 0) + r.n;
    }
    return keys.map((key) => ({ key, counts: byKey.get(key)! }));
  }
  dailyMetrics(opts: { deviceId?: string; from: string; to: string }): DailyMetricRow[] {
    const where = ["day >= ? AND day <= ?"]; const args: any[] = [opts.from, opts.to];
    if (opts.deviceId) { where.push("deviceId = ?"); args.push(opts.deviceId); }
    return (this.db.prepare(`SELECT * FROM dailyMetric WHERE ${where.join(" AND ")} ORDER BY day, deviceId`).all(...args) as any[]).map(withFamily);
  }
  sleepSummary(opts: { from: string; to: string }): SleepRow[] {
    const lo = Math.floor(new Date(`${opts.from}T00:00:00Z`).getTime() / 1000);
    const hi = Math.floor(new Date(`${opts.to}T23:59:59Z`).getTime() / 1000);
    return (this.db.prepare(`SELECT deviceId,startTs,endTs,efficiency,restingHr,avgHrv,userEdited FROM sleepSession WHERE startTs >= ? AND startTs <= ? ORDER BY startTs`).all(lo, hi) as any[]).map(withFamily);
  }
  workoutSummary(opts: { from: string; to: string }): WorkoutRow[] {
    const lo = Math.floor(new Date(`${opts.from}T00:00:00Z`).getTime() / 1000);
    const hi = Math.floor(new Date(`${opts.to}T23:59:59Z`).getTime() / 1000);
    return (this.db.prepare(`SELECT deviceId,startTs,endTs,sport,source,durationS,energyKcal,distanceM FROM workout WHERE startTs >= ? AND startTs <= ? ORDER BY startTs`).all(lo, hi) as any[]).map(withFamily);
  }
  metricSeries(opts: { deviceId?: string; key?: string; from: string; to: string }): MetricPointRow[] {
    const where = ["day >= ? AND day <= ?"]; const args: any[] = [opts.from, opts.to];
    if (opts.deviceId) { where.push("deviceId = ?"); args.push(opts.deviceId); }
    if (opts.key) { where.push("key = ?"); args.push(opts.key); }
    return (this.db.prepare(`SELECT deviceId,day,key,value FROM metricSeries WHERE ${where.join(" AND ")} ORDER BY day, key`).all(...args) as any[]).map(withFamily);
  }
  // Batched lookup for compareSources' metricSeries fallback: one query for every requested
  // metric name across the whole day range, instead of a per-day/per-metric loop.
  metricSeriesForKeys(opts: { keys: string[]; from: string; to: string }): MetricPointRow[] {
    if (opts.keys.length === 0) return [];
    const placeholders = opts.keys.map(() => "?").join(",");
    return (this.db.prepare(`SELECT deviceId,day,key,value FROM metricSeries WHERE day >= ? AND day <= ? AND key IN (${placeholders}) ORDER BY day, key`).all(opts.from, opts.to, ...opts.keys) as any[]).map(withFamily);
  }
  latestDataDay(): string | null { return (this.db.prepare("SELECT MAX(day) AS d FROM dailyMetric").get() as any)?.d ?? null; }
  hrCoverageDays(deviceId: string): number { return (this.db.prepare("SELECT COUNT(DISTINCT date(ts,'unixepoch')) AS c FROM hrSample WHERE deviceId = ?").get(deviceId) as any).c; }
  hrSamplesRange(opts: { fromTs: number; toTs: number; deviceId?: string; limit: number }): { deviceId: string; ts: number; bpm: number }[] {
    const where = ["ts >= ? AND ts <= ?"]; const args: any[] = [opts.fromTs, opts.toTs];
    if (opts.deviceId) { where.push("deviceId = ?"); args.push(opts.deviceId); }
    args.push(opts.limit);
    return this.db.prepare(`SELECT deviceId, ts, bpm FROM hrSample WHERE ${where.join(" AND ")} ORDER BY ts LIMIT ?`).all(...args) as any[];
  }
  // RR granularity is sub-second but ts is not, so two+ real beats routinely share one integer-second
  // ts (common at resting HR: ~800ms RR means roughly every other beat lands in a new second). The
  // app's own rrIntervals read (Packages/WhoopStore/Sources/WhoopStore/Reads.swift) tiebreaks same-ts
  // rows with `ORDER BY ts, rrMs, seq` — fine for a plain listing, but WRONG for hrv_series: sorting
  // same-ts beats by VALUE can swap two genuinely-successive beats whenever the earlier one has the
  // larger rrMs (proven by a failing test: an 800/850ms-alternating series lost its constant ±50ms
  // successive diff exactly at a same-second pair, pulling RMSSD from 50ms to 46ms). `rowid` reflects
  // real insertion/arrival order and isn't a value, so it can't invert two beats' true sequence —
  // ordering by it instead is a deliberate deviation from the app's own query, not an oversight.
  rrIntervalsRange(opts: { fromTs: number; toTs: number; deviceId?: string; limit: number }): RRIntervalRow[] {
    const where = ["ts >= ? AND ts <= ?"]; const args: any[] = [opts.fromTs, opts.toTs];
    if (opts.deviceId) { where.push("deviceId = ?"); args.push(opts.deviceId); }
    args.push(opts.limit);
    return this.db.prepare(`SELECT deviceId, ts, rrMs FROM rrInterval WHERE ${where.join(" AND ")} ORDER BY ts, rowid LIMIT ?`).all(...args) as any[];
  }
  sleepSessionAt(deviceId: string, startTs: number) {
    return (this.db.prepare("SELECT deviceId, startTs, endTs, efficiency, restingHr, avgHrv, userEdited, stagesJSON FROM sleepSession WHERE deviceId = ? AND startTs = ?").get(deviceId, startTs) as any) ?? null;
  }

  // Real phone schema carries stepSample/gravitySample from CoreMotion, but any mirror ingested
  // before this feature shipped won't have them — check sqlite_master rather than assume present.
  hasTable(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  }
  // The phone's per-local-day IANA timezone (WhoopStore v28 `phoneTimezone` table). Mirrors ingested
  // before that migration shipped lack the table entirely — return an empty map rather than throw, so
  // sleep_summary degrades to "no tzId" instead of crashing on an older upload.
  phoneTimezones(): Map<string, string> {
    if (!this.hasTable("phoneTimezone")) return new Map();
    const rows = this.db.prepare("SELECT day, tzId FROM phoneTimezone").all() as { day: string; tzId: string }[];
    return new Map(rows.map((r) => [r.day, r.tzId]));
  }
  stepSamplesRange(opts: { fromTs: number; toTs: number; deviceId?: string; limit: number }): StepSampleRow[] {
    if (!this.hasTable("stepSample")) return [];
    const where = ["ts >= ? AND ts <= ?"]; const args: any[] = [opts.fromTs, opts.toTs];
    if (opts.deviceId) { where.push("deviceId = ?"); args.push(opts.deviceId); }
    args.push(opts.limit);
    return this.db.prepare(`SELECT deviceId, ts, counter, activityClass FROM stepSample WHERE ${where.join(" AND ")} ORDER BY ts LIMIT ?`).all(...args) as any[];
  }
  gravitySamplesRange(opts: { fromTs: number; toTs: number; deviceId?: string; limit: number }): GravitySampleRow[] {
    if (!this.hasTable("gravitySample")) return [];
    const where = ["ts >= ? AND ts <= ?"]; const args: any[] = [opts.fromTs, opts.toTs];
    if (opts.deviceId) { where.push("deviceId = ?"); args.push(opts.deviceId); }
    args.push(opts.limit);
    return this.db.prepare(`SELECT deviceId, ts, x, y, z FROM gravitySample WHERE ${where.join(" AND ")} ORDER BY ts LIMIT ?`).all(...args) as any[];
  }

  // appleStepHour is populated by the iPhone-side hourly step import (NOOP commit d47525ea), written
  // under deviceId "apple-health" — absent from any mirror uploaded before that phone build shipped,
  // so this shares the hasTable tolerance pattern above rather than assuming the table exists. Rows
  // are already pre-aggregated per hour (ts = hour-start, one steps total per hour), unlike
  // stepSample's raw wrap-aware counter stream, so no delta math and no limit/deviceId filter: a
  // 7-day (MAX_SPAN_S) window is at most 168 rows.
  appleStepHours(fromTs: number, toTs: number): { deviceId: string; ts: number; steps: number }[] {
    if (!this.hasTable("appleStepHour")) return [];
    return this.db.prepare("SELECT deviceId, ts, steps FROM appleStepHour WHERE ts >= ? AND ts <= ? ORDER BY ts").all(fromTs, toTs) as any[];
  }
}
