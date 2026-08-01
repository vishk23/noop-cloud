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
// Per-second WHOOP skin-temperature register (WhoopStore `skinTempSample`, migration v3). `raw` is the
// SCALE-AGNOSTIC register the historical decoder banks (WhoopProtocol `SkinTempSample`), NOT °C — the
// raw→°C conversion is DEVICE-FAMILY-AWARE (5/MG raw/100 vs 4.0 affine, issue #938) and lives with
// temp_series in tools/granular.ts, not here, so this reader stays lossless.
export interface SkinTempSampleRow { deviceId: string; ts: number; raw: number; }
export interface RRIntervalRow { deviceId: string; ts: number; rrMs: number; }
// `soc` is PERCENT (0-100), not a 0-1 fraction — see batterySamplesRange below for the provenance.
// All three value columns are nullable: the command-response battery path fills only what it read.
// `charging` is SQLite BOOLEAN, i.e. an INTEGER 0/1 (or null) out of better-sqlite3 — battery_series
// in tools/granular.ts is what normalizes it to a real boolean for callers.
export interface BatterySampleRow { deviceId: string; ts: number; soc: number | null; mv: number | null; charging: number | null; }
// The strap's own firmware event log (WhoopStore `event` table, migration v1). `kind` is NOT a bare
// label — it is always "LABEL(opcode)" (e.g. "WRIST_ON(9)") for an event the protocol schema names, and
// "0xNN(opcode)" (e.g. "0x6E(110)") for one it doesn't; see eventsRange below for the provenance.
// `payloadJSON` is TEXT NOT NULL and is "{}" for almost every kind — device_events in tools/granular.ts
// is what parses it and splits `kind` into label/opcode.
export interface EventRow { deviceId: string; ts: number; kind: string; payloadJSON: string; }
export interface EventKindCount { kind: string; n: number; firstTs: number; lastTs: number; }

const withFamily = <T extends { deviceId: string }>(r: T) => ({ ...r, family: sourceFamily(r.deviceId) });

/**
 * An epoch-seconds value JS `Date` can actually represent, or null.
 *
 * The mirror's `ts` columns are whatever the phone wrote, and a corrupt or garbage row is not
 * hypothetical. SQLite's `date(ts,'unixepoch')` answers NULL for a timestamp out of range;
 * `new Date(ts*1000).toISOString()` throws `RangeError: Invalid time value` instead — so moving the
 * day formatting from SQL into JS quietly armed one bad row to take down `data_freshness`, the tool
 * the noop-health contract calls FIRST and the one that has to survive whatever else is broken.
 * This restores SQLite's answer: unrepresentable reads as unknown, not as a failure.
 */
const MAX_EPOCH_MS = 8.64e15; // ECMA-262 time-value range: ±100,000,000 days from the epoch
function representableTs(ts: number | null | undefined): number | null {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts * 1000) <= MAX_EPOCH_MS ? ts : null;
}
const dayOf = (ts: number | null) => (ts === null ? null : new Date(ts * 1000).toISOString().slice(0, 10));

// Match a caller-supplied kind either EXACTLY ("WRIST_ON(9)") or by its bare LABEL ("WRIST_ON"), so an
// agent that never saw the "(opcode)" suffix can still filter. Deliberately substr/instr rather than
// `kind LIKE ? || '('`: event labels are full of underscores (WRIST_ON, BLE_CONNECTION_UP) and `_` is a
// LIKE single-char wildcard, so the LIKE form would quietly match neighbouring labels. Labels never
// contain "(" (Schema.enumName builds them as name + "(" + v + ")"), so the first "(" is the split.
function kindFilterSql(kinds: string[]): { sql: string; args: string[] } {
  const clause = "(kind = ? OR (instr(kind, '(') > 0 AND substr(kind, 1, instr(kind, '(') - 1) = ?))";
  return { sql: `(${kinds.map(() => clause).join(" OR ")})`, args: kinds.flatMap((k) => [k, k]) };
}

export class Mirror {
  private db: Database.Database;
  /**
   * `busyTimeoutMs` overrides better-sqlite3's default 5000 ms `busy_timeout`. Every one of the 20
   * tool call sites omits it and therefore behaves exactly as it always has; only the /healthz probe
   * passes it (see storage.ts::mirrorReadable).
   *
   * Why the knob exists at all: under liters page replication the mirror is written IN PLACE by
   * another process, which holds SQLite's EXCLUSIVE lock pair for the duration of an apply. Readers
   * therefore wait where they never used to. 5 s is the right ceiling for a tool call — it sits out
   * any realistic apply — but it is exactly Fly's health-check timeout, so a probe that waited the
   * full default would fail the check and pull a perfectly healthy machine out of routing.
   */
  constructor(path: string, opts: { busyTimeoutMs?: number } = {}) {
    this.db = new Database(path, {
      readonly: true,
      fileMustExist: true,
      ...(opts.busyTimeoutMs === undefined ? {} : { timeout: opts.busyTimeoutMs }),
    });
  }
  close(): void { this.db.close(); }

  // Union deviceIds across dailyMetric, sleepSession, hrSample, and rrInterval: a device that only
  // ever writes raw samples (e.g. a strap deviceId, whose scored daily rollups land under a separate
  // derived "-noop" deviceId) previously had no dailyMetric row and was invisible here even
  // though it holds real data. One cheap GROUP BY per table (each aggregated off that table's own
  // deviceId-prefixed primary key), unioned in JS; `tables` records which of the four a source
  // actually appears in — rrInterval's presence there is how a caller learns which deviceIds carry
  // beat-to-beat R-R data (WHOOP-only; see hrv_series in src/tools/granular.ts).
  // `latestTs` rides along on the timestamp-keyed tables at no extra cost, and is what
  // data_freshness reports as `latestSampleAt`: the mirror's mtime says the FILE was written, which
  // is a different claim from "new data arrived" — an apply that touches only bookkeeping pages
  // moves one and not the other. Null for the day-keyed tables (dailyMetric, appleDaily), which
  // carry no timestamp to take a MAX of.
  //
  // Taking `MAX(ts)` and formatting the day in JS, rather than `MAX(date(ts,'unixepoch'))`, is not a
  // rewrite: `date()` is monotonic non-decreasing in `ts`, so the max commutes with it and the day
  // is identical. It is also strictly cheaper — one conversion per GROUP rather than per ROW — and
  // `.toISOString()` renders the same UTC calendar day SQLite's `date(…,'unixepoch')` does.
  sources() {
    const tsRows = (sql: string) => (this.db.prepare(sql).all() as { deviceId: string; maxTs: number | null }[])
      .map((r) => { const ts = representableTs(r.maxTs); return { deviceId: r.deviceId, maxDay: dayOf(ts), maxTs: ts }; });
    const dm = this.db.prepare(`SELECT deviceId, MAX(day) AS maxDay FROM dailyMetric GROUP BY deviceId`).all() as { deviceId: string; maxDay: string | null }[];
    const ss = tsRows(`SELECT deviceId, MAX(startTs) AS maxTs FROM sleepSession GROUP BY deviceId`);
    const hr = tsRows(`SELECT deviceId, MAX(ts) AS maxTs FROM hrSample GROUP BY deviceId`);
    const rr = tsRows(`SELECT deviceId, MAX(ts) AS maxTs FROM rrInterval GROUP BY deviceId`);
    const byDevice = new Map<string, { tables: Set<string>; latestDay: string | null; latestTs: number | null }>();
    const merge = (rows: { deviceId: string; maxDay: string | null; maxTs?: number | null }[], table: string) => {
      for (const r of rows) {
        const e = byDevice.get(r.deviceId) ?? { tables: new Set<string>(), latestDay: null, latestTs: null };
        e.tables.add(table);
        if (r.maxDay && (!e.latestDay || r.maxDay > e.latestDay)) e.latestDay = r.maxDay;
        if (r.maxTs != null && (e.latestTs === null || r.maxTs > e.latestTs)) e.latestTs = r.maxTs;
        byDevice.set(r.deviceId, e);
      }
    };
    // The Apple Health import's real data is in appleDaily/appleStepHour, NOT in dailyMetric: it
    // writes a dailyMetric row carrying only (deviceId, day) with every metric column NULL. So
    // freshness derived from the four tables above read apple-health's latestDay off rows that
    // contain nothing, which is the worst kind of wrong here — this is the "call this first" tool,
    // and it reported a source as current on the strength of empty placeholders. Both tables are
    // hasTable-guarded like the rest of the optional streams, since a mirror ingested from an older
    // backup may predate either.
    const ad = this.hasTable("appleDaily")
      ? this.db.prepare(`SELECT deviceId, MAX(day) AS maxDay FROM appleDaily GROUP BY deviceId`).all() as { deviceId: string; maxDay: string | null }[]
      : [];
    const ah = this.hasTable("appleStepHour")
      ? tsRows(`SELECT deviceId, MAX(ts) AS maxTs FROM appleStepHour GROUP BY deviceId`)
      : [];
    merge(dm, "dailyMetric"); merge(ss, "sleepSession"); merge(hr, "hrSample"); merge(rr, "rrInterval");
    merge(ad, "appleDaily"); merge(ah, "appleStepHour");
    const brandById = new Map((this.db.prepare("SELECT id, brand FROM pairedDevice").all() as { id: string; brand: string | null }[]).map((b) => [b.id, b.brand]));
    return [...byDevice.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([deviceId, e]) => ({ deviceId, family: sourceFamily(deviceId), brand: brandById.get(deviceId) ?? null, latestDay: e.latestDay, latestTs: e.latestTs, tables: [...e.tables].sort() }));
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
  // UNIONs ppgHrSample into the HR read, exactly as the phone does. This is not an enhancement — it is a
  // correctness fix. `ppgHrSample` holds the per-second HR the v26 optical estimator derives for seconds
  // the strap never reported a bpm for, and the app treats it as a first-class HR source: Reads.swift
  // unions it into `hrSamples`, `hrWindowStats` (workout avg/max), `hrBuckets` (the chart), and the
  // day-has-data gate, and it reaches HealthKit export. Android matches (WhoopDao.kt). Reading `hrSample`
  // alone made the cloud blind to ~36.8k HR seconds the phone counts, so hr_series and every agent answer
  // built on it silently under-reported.
  //
  // The anti-join is the load-bearing part and is copied from the phone verbatim: a PPG estimate is only
  // admitted for a second with NO measured row, so a real bpm is never double-counted by, or replaced
  // with, its estimate. Same rounding too — the phone CASTs to its Int bpm domain, and matching that keeps
  // a cloud answer byte-comparable with the app's.
  //
  // Materially this is ~1.6% of WHOOP-era strap-seconds, so daily averages barely move — but the seconds
  // are CONCENTRATED in v26-heavy stretches, which is precisely the failure PR #841 hit on Android: a
  // PPG-heavy workout drew a full chart and reported a blank average.
  hrSamplesRange(opts: { fromTs: number; toTs: number; deviceId?: string; limit: number }): { deviceId: string; ts: number; bpm: number }[] {
    const where = ["ts >= ? AND ts <= ?"]; const args: any[] = [opts.fromTs, opts.toTs];
    if (opts.deviceId) { where.push("deviceId = ?"); args.push(opts.deviceId); }
    // hasTable-guarded like imuActivity/event: ppgHrSample arrived in a phone migration, so a mirror
    // ingested from an older backup (or a fixture) may not carry it. Falling back to the measured-only
    // read keeps those working rather than throwing "no such table" on every HR question.
    if (!this.hasTable("ppgHrSample")) {
      return this.db.prepare(`SELECT deviceId, ts, bpm FROM hrSample WHERE ${where.join(" AND ")} ORDER BY ts LIMIT ?`)
        .all(...args, opts.limit) as any[];
    }
    // The PPG leg needs its own copy of the same bounds (and deviceId) — one args array, in leg order.
    const ppgWhere = ["p.ts >= ? AND p.ts <= ?"]; const ppgArgs: any[] = [opts.fromTs, opts.toTs];
    if (opts.deviceId) { ppgWhere.push("p.deviceId = ?"); ppgArgs.push(opts.deviceId); }
    return this.db.prepare(`
      SELECT deviceId, ts, bpm FROM (
        SELECT deviceId, ts, bpm FROM hrSample WHERE ${where.join(" AND ")}
        UNION ALL
        SELECT p.deviceId, p.ts, CAST(ROUND(p.bpm) AS INTEGER) AS bpm FROM ppgHrSample p
        WHERE ${ppgWhere.join(" AND ")}
          AND NOT EXISTS (
            SELECT 1 FROM hrSample h WHERE h.deviceId = p.deviceId AND h.ts = p.ts)
      )
      ORDER BY ts LIMIT ?`).all(...args, ...ppgArgs, opts.limit) as any[];
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

  // v28-imu-activity: per-second IMU activity features derived from the WHOOP 5/MG raw 6-axis offload
  // buffer (WhoopStore `imuActivity` table). WHOOP 5/MG-only, and only present once that migration
  // shipped AND a deep-buffer capture ran — imu_series guards with hasTable("imuActivity") before
  // calling this, which assumes the table exists. cadenceHz is nullable (a still/bursty wrist).
  // sampleCount is not selected: no caller reads it, and it holds the producer's OVERLAPPING
  // trailing-window size rather than the second's own samples, so it is not a quantity to aggregate
  // (see imuCoverageRange).
  imuActivityRange(opts: { fromTs: number; toTs: number; deviceId?: string; limit: number }):
    { deviceId: string; ts: number; accelEnergyG: number; gyroEnergyDps: number; jerkRms: number; cadenceHz: number | null; cadenceStrength: number }[] {
    const where = ["ts >= ? AND ts <= ?"]; const args: any[] = [opts.fromTs, opts.toTs];
    if (opts.deviceId) { where.push("deviceId = ?"); args.push(opts.deviceId); }
    args.push(opts.limit);
    return this.db.prepare(`SELECT deviceId, ts, accelEnergyG, gyroEnergyDps, jerkRms, cadenceHz, cadenceStrength FROM imuActivity WHERE ${where.join(" AND ")} ORDER BY ts LIMIT ?`).all(...args) as any[];
  }

  // Per-second IMU rows reduced to a COVERAGE question ("do I have deep buffers at all, and when?")
  // rather than the feature values imu_series buckets. Selects only what the session roll-up needs, so
  // this stays cheap on a wide window: the whole point is that a caller can ask about months without
  // pulling accel/gyro/jerk for every second. sampleCount is NOT among them, and adding it back would be
  // a mistake rather than an omission: it carries the producer's OVERLAPPING trailing-window size, not
  // the second's own samples, so a coverage roll-up has nothing honest to do with it (see imuCoverage).
  // ORDER BY deviceId, ts — imuCoverage walks it in that order to cut sessions per device. Table-guarded
  // like stepSamplesRange: opt-in 5/MG capture means plenty of real mirrors never carry it.
  imuCoverageRange(opts: { fromTs: number; toTs: number; deviceId?: string; limit: number }):
    { deviceId: string; ts: number; cadenceHz: number | null; accelEnergyG: number }[] {
    if (!this.hasTable("imuActivity")) return [];
    const where = ["ts >= ? AND ts <= ?"]; const args: any[] = [opts.fromTs, opts.toTs];
    if (opts.deviceId) { where.push("deviceId = ?"); args.push(opts.deviceId); }
    args.push(opts.limit);
    return this.db.prepare(`SELECT deviceId, ts, cadenceHz, accelEnergyG FROM imuActivity WHERE ${where.join(" AND ")} ORDER BY deviceId, ts LIMIT ?`).all(...args) as any[];
  }

  // The full ts extent of imuActivity, ignoring any range — what a from/to-less imu_coverage call
  // anchors on so "when do I have buffers at all?" needs no guessed window. Cheap: min/max over the
  // (deviceId, ts) primary key.
  imuActivityExtent(deviceId?: string): { firstTs: number; lastTs: number; n: number } | null {
    if (!this.hasTable("imuActivity")) return null;
    const where = deviceId ? "WHERE deviceId = ?" : "";
    const args = deviceId ? [deviceId] : [];
    const r = this.db.prepare(`SELECT MIN(ts) firstTs, MAX(ts) lastTs, COUNT(*) n FROM imuActivity ${where}`).get(...args) as any;
    return r && r.n > 0 ? r : null;
  }

  // The strap's firmware event log over a range (WhoopStore `event` table). The rows are whatever the
  // strap banked and the phone offloaded over BLE — WHOOP-only in practice: nothing on the cloud-import
  // path (oura-api) writes here, so an events question about an Oura source is always empty.
  //
  // `kind` PROVENANCE, read off the producer rather than assumed: StreamStore.swift inserts e.kind
  // verbatim, and that string comes from WhoopProtocol Schema.swift's `enumName`, which returns
  // "\(name)(\(v))" when the schema names the opcode and String(format: "0x%02X(%d)", v, v) when it
  // doesn't. So the opcode is ALWAYS present in parentheses, and a "0x6E(110)" kind means "the strap
  // sent event 110 and our schema has no name for it" — real signal, not corruption.
  //
  // Columns are listed explicitly because migration v5 added a `synced` upload flag the cloud never
  // surfaces. hasTable-guarded for the same reason as stepSamplesRange: a fixture or foreign mirror
  // may not carry it.
  eventsRange(opts: { fromTs: number; toTs: number; deviceId?: string; kinds?: string[]; limit: number }): EventRow[] {
    if (!this.hasTable("event")) return [];
    const where = ["ts >= ? AND ts <= ?"]; const args: any[] = [opts.fromTs, opts.toTs];
    if (opts.deviceId) { where.push("deviceId = ?"); args.push(opts.deviceId); }
    if (opts.kinds?.length) { const f = kindFilterSql(opts.kinds); where.push(f.sql); args.push(...f.args); }
    args.push(opts.limit);
    return this.db.prepare(`SELECT deviceId, ts, kind, payloadJSON FROM event WHERE ${where.join(" AND ")} ORDER BY ts LIMIT ?`).all(...args) as any[];
  }

  // Per-kind counts over the SAME range/filters as eventsRange, aggregated in SQL rather than derived
  // from the returned rows. That difference is load-bearing: eventsRange is capped, so counting the
  // rows it hands back would under-report exactly when the window is busiest — the moment a caller most
  // needs a true tally. This aggregate is never truncated.
  eventKindCounts(opts: { fromTs: number; toTs: number; deviceId?: string; kinds?: string[] }): EventKindCount[] {
    if (!this.hasTable("event")) return [];
    const where = ["ts >= ? AND ts <= ?"]; const args: any[] = [opts.fromTs, opts.toTs];
    if (opts.deviceId) { where.push("deviceId = ?"); args.push(opts.deviceId); }
    if (opts.kinds?.length) { const f = kindFilterSql(opts.kinds); where.push(f.sql); args.push(...f.args); }
    return this.db.prepare(`SELECT kind, COUNT(*) n, MIN(ts) firstTs, MAX(ts) lastTs FROM event WHERE ${where.join(" AND ")} GROUP BY kind ORDER BY n DESC, kind`).all(...args) as any[];
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

  // Raw per-second skin-temperature register over a range (WhoopStore `skinTempSample`, migration v3).
  // hasTable-guarded like the other opt-era sample readers: an upload from before v3 shipped won't
  // carry it. `raw` passes through untouched (off-wrist/ambient reads included) — Default: capture and
  // expose the stream losslessly; temp_series does the family-aware raw→°C and any wear interpretation.
  skinTempSamplesRange(opts: { fromTs: number; toTs: number; deviceId?: string; limit: number }): SkinTempSampleRow[] {
    if (!this.hasTable("skinTempSample")) return [];
    const where = ["ts >= ? AND ts <= ?"]; const args: any[] = [opts.fromTs, opts.toTs];
    if (opts.deviceId) { where.push("deviceId = ?"); args.push(opts.deviceId); }
    args.push(opts.limit);
    return this.db.prepare(`SELECT deviceId, ts, raw FROM skinTempSample WHERE ${where.join(" AND ")} ORDER BY ts LIMIT ?`).all(...args) as any[];
  }
  // Full ts extent of skinTempSample — the "how far back does per-second temp retain?" answer, which a
  // 7-day-capped temp_series can't give. Cheap min/max over the (deviceId, ts) primary key.
  skinTempExtent(deviceId?: string): { firstTs: number; lastTs: number; n: number } | null {
    if (!this.hasTable("skinTempSample")) return null;
    const where = deviceId ? "WHERE deviceId = ?" : "";
    const args = deviceId ? [deviceId] : [];
    const r = this.db.prepare(`SELECT MIN(ts) firstTs, MAX(ts) lastTs, COUNT(*) n FROM skinTempSample ${where}`).get(...args) as any;
    return r && r.n > 0 ? r : null;
  }
  // deviceId → registry `model` label (pairedDevice), for temp_series' family-aware raw→°C conversion.
  // Guarded (empty map on a mirror without the table) so conversion falls back to the 5/MG scale, which
  // is exactly what DeviceFamily.forRegistryModel does for a nil/unknown model.
  pairedDeviceModels(): Map<string, string | null> {
    if (!this.hasTable("pairedDevice")) return new Map();
    const rows = this.db.prepare("SELECT id, model FROM pairedDevice").all() as { id: string; model: string | null }[];
    return new Map(rows.map((r) => [r.id, r.model]));
  }

  // The strap's OWN per-second band sleep-state (WhoopStore `sleepStateSample`, migration @81 high nibble,
  // #175): `state` is 0=wake / 1=still / 2=asleep / 3=up — a coarse activity band, NOT the light/deep/rem
  // hypnogram (that lives in sleepSession.stagesJSON, surfaced by sleep_detail). hasTable-guarded like the
  // other opt-era streams. sleep_state_series does the labelling + run-length encoding.
  sleepStateSamplesRange(opts: { fromTs: number; toTs: number; deviceId?: string; limit: number }): { deviceId: string; ts: number; state: number }[] {
    if (!this.hasTable("sleepStateSample")) return [];
    const where = ["ts >= ? AND ts <= ?"]; const args: any[] = [opts.fromTs, opts.toTs];
    if (opts.deviceId) { where.push("deviceId = ?"); args.push(opts.deviceId); }
    args.push(opts.limit);
    return this.db.prepare(`SELECT deviceId, ts, state FROM sleepStateSample WHERE ${where.join(" AND ")} ORDER BY ts LIMIT ?`).all(...args) as any[];
  }
  sleepStateExtent(deviceId?: string): { firstTs: number; lastTs: number; n: number } | null {
    if (!this.hasTable("sleepStateSample")) return null;
    const where = deviceId ? "WHERE deviceId = ?" : "";
    const args = deviceId ? [deviceId] : [];
    const r = this.db.prepare(`SELECT MIN(ts) firstTs, MAX(ts) lastTs, COUNT(*) n FROM sleepStateSample ${where}`).get(...args) as any;
    return r && r.n > 0 ? r : null;
  }

  // Per-table inventory of the whole mirror — row count, time span, and contributing deviceIds — for the
  // `streams` discovery tool, so an agent can see WHAT raw streams exist and how much data each holds
  // without reading the DB out of band. Table names come from sqlite_master (never user input), so
  // interpolating them is safe; PRAGMA/aggregate can't be parameterised anyway. `timeCol` is whichever of
  // ts/startTs/day the table carries (null for keyless tables); `first`/`last` are that column's min/max
  // (epoch ints for ts/startTs, YYYY-MM-DD strings for day). COUNT(*)/DISTINCT scan, which is fine for an
  // occasional meta-call but is why this isn't on a hot path.
  streamInventory(): { table: string; rows: number; timeCol: string | null; first: number | string | null; last: number | string | null; deviceIds: string[] }[] {
    const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    const out: { table: string; rows: number; timeCol: string | null; first: number | string | null; last: number | string | null; deviceIds: string[] }[] = [];
    for (const table of tables) {
      const cols = (this.db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
      const timeCol = ["ts", "startTs", "day"].find((c) => cols.includes(c)) ?? null;
      const rows = (this.db.prepare(`SELECT COUNT(*) n FROM "${table}"`).get() as any).n as number;
      let first: number | string | null = null, last: number | string | null = null, deviceIds: string[] = [];
      if (rows > 0 && timeCol) { const r = this.db.prepare(`SELECT MIN(${timeCol}) a, MAX(${timeCol}) b FROM "${table}"`).get() as any; first = r.a; last = r.b; }
      if (rows > 0 && cols.includes("deviceId")) deviceIds = (this.db.prepare(`SELECT DISTINCT deviceId FROM "${table}"`).all() as any[]).map((r) => r.deviceId);
      out.push({ table, rows, timeCol, first, last, deviceIds });
    }
    return out;
  }

  // The paired wearable's own battery telemetry, banked over BLE (WhoopStore `battery` table). UNITS,
  // confirmed against the producer rather than assumed: `soc` is PERCENT (0-100) as a REAL, NOT a 0-1
  // fraction — the WHOOP BATTERY_LEVEL decoder emits it as the wire word / 10 tagged "%" (Interpreter
  // .swift's `battery_pct` @21 and PostHooks.swift's "soc@17(/10) mv@21 charge@26" region note in the
  // NOOP app repo), the Oura BLE mapping stores `Double(v.percent)` (OuraStreamMapping.swift), and
  // StrandAnalytics' BatteryEstimator documents its anchor as "the latest SoC ... in percent" with
  // percent-scale constants (nearFullPct 90, chargeStepPct 1). That /10 means real readings carry one
  // decimal (e.g. 82.5), so callers must not round to an int. `mv` is raw cell millivolts.
  //
  // Columns are named explicitly rather than SELECT * because migration v5 added a `synced` upload flag
  // the cloud never surfaces. `charging` came in v6 and is assumed present — the app is long past it and
  // every other reader here likewise assumes its era's columns — while hasTable() guards the table
  // itself for the same reason stepSamplesRange does: a fixture or foreign mirror may not carry it.
  batterySamplesRange(opts: { fromTs: number; toTs: number; deviceId?: string; limit: number }): BatterySampleRow[] {
    if (!this.hasTable("battery")) return [];
    const where = ["ts >= ? AND ts <= ?"]; const args: any[] = [opts.fromTs, opts.toTs];
    if (opts.deviceId) { where.push("deviceId = ?"); args.push(opts.deviceId); }
    args.push(opts.limit);
    return this.db.prepare(`SELECT deviceId, ts, soc, mv, charging FROM battery WHERE ${where.join(" AND ")} ORDER BY ts LIMIT ?`).all(...args) as any[];
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
