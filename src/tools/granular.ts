import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { Mirror, sourceFamily } from "../mirror.js";
import { computeOverlay, sleepKeyOf } from "../edits/overlay.js";

const asTool = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> });
const toTs = (s: string, endOfDay = false) => /^\d{4}-\d{2}-\d{2}$/.test(s)
  ? Math.floor(new Date(`${s}T${endOfDay ? "23:59:59" : "00:00:00"}Z`).getTime() / 1000)
  : Math.floor(new Date(s).getTime() / 1000);
const MAX_SPAN_S = 7 * 86_400, RAW_CAP = 5000;
// sleepDetail's step/gravity reads only (NOT hr_series' RAW_CAP above): a sleep session is
// time-bounded (~14h max in practice) unlike hr_series' open-ended window, and real motion cadence
// runs ~2 rows/sec — 14h * 3600 * 2 ≈ 100k rows, so 500k gives ~5x headroom. Raised from RAW_CAP(5000)
// after a live mirror proved 5000 silently undercounts steps/postureChanges 3-4x on a real ~22k-row
// night (post-hoc review Critical, 2026-07-12): the read was truncated with no signal, so sleep_detail
// reported 17 steps / 5 postureChanges against a true 70 / 15.
const MOTION_RAW_CAP = 500_000;
// motion_series spans up to 7 days (MAX_SPAN_S) with no per-session bound, so unlike sleepDetail this
// can still truncate on a wide window with dense motion (e.g. >1.5 days of continuous ~2 rows/sec
// motion at the old default). Kept at 200k rather than raised — surfaced via `truncated`/`hint`
// instead, since a caller who hits this should narrow the window or bucket more coarsely, not silently
// pull an unbounded read.
const SERIES_CAP = 200_000;
// sleepDetail's own HR read (hrDuringSleep): same time-bound reasoning as MOTION_RAW_CAP above (a
// session is ~14h max in practice), sized for HR's cadence (up to ~1Hz in practice, so ~14h*3600 ≈
// 50k rows; 250k gives ~5x headroom). This is the FETCH cap used to learn the true in-window sample
// count for decimateEvenly() below — the cap on what's actually returned stays RAW_CAP(5000).
// Audit-exposed (2026-07-13): a 6.4h/~23k-sample night at 1Hz used to hit RAW_CAP(5000) via a raw SQL
// `ORDER BY ts LIMIT`, silently returning only the first ~83 minutes with no signal the tail was
// missing — this misled a live investigation.
const HR_DETAIL_RAW_CAP = 250_000;
// hrvSeries' raw rrInterval read: rows land roughly one per heartbeat, denser than hrSample's
// multi-second cadence, so a 7-day (MAX_SPAN_S) window can hold far more rows than hr_series' 200k
// bucketed-read limit. Sized like MOTION_RAW_CAP's ~5x-headroom reasoning above rather than reused,
// since RR and HR sample density differ; a hit is surfaced via truncated/hint (see hrvSeries below),
// never silently dropped.
const RR_RAW_CAP = 500_000;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const round1 = (x: number) => Math.round(x * 10) / 10;

function dropDeleted(samples: { deviceId: string; ts: number; bpm: number }[], ranges: { deviceId: string; fromTs: number; toTs: number }[]) {
  if (!ranges.length) return samples;
  return samples.filter((s) => !ranges.some((r) => r.deviceId === s.deviceId && s.ts >= r.fromTs && s.ts <= r.toTs));
}

// Evenly decimate `rows` (already ORDER BY ts) down to at most `cap` entries by taking every
// `stride`-th row (stride = ceil(n/cap)) instead of a head-truncation that silently drops everything
// past the first `cap` rows — see sleepDetail's HR read below and HR_DETAIL_RAW_CAP above. Below the
// cap, this is a no-op (same rows, same order).
function decimateEvenly<T>(rows: T[], cap: number): { rows: T[]; decimated: boolean; stride: number; total: number } {
  const total = rows.length;
  if (total <= cap) return { rows, decimated: false, stride: 1, total };
  const stride = Math.ceil(total / cap);
  const out: T[] = [];
  for (let i = 0; i < total; i += stride) out.push(rows[i]);
  return { rows: out, decimated: true, stride, total };
}

// Average gravity per fixed-size bucket, sorted — shared by motionSeries (variable bucket) and
// countPostureChanges (fixed 5-min bucket per the sleep_detail contract).
function bucketGravity(rows: { ts: number; x: number; y: number; z: number }[], bucketSeconds: number) {
  const byBucket = new Map<number, { sx: number; sy: number; sz: number; n: number }>();
  for (const g of rows) {
    const bt = Math.floor(g.ts / bucketSeconds) * bucketSeconds;
    const cur = byBucket.get(bt) ?? { sx: 0, sy: 0, sz: 0, n: 0 };
    cur.sx += g.x; cur.sy += g.y; cur.sz += g.z; cur.n += 1;
    byBucket.set(bt, cur);
  }
  return [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([ts, s]) => ({ ts, x: s.sx / s.n, y: s.sy / s.n, z: s.sz / s.n }));
}
// Cheap movement proxy: count adjacent 5-min-bucket gravity-average shifts where any axis moves >0.5g.
function countPostureChanges(rows: { ts: number; x: number; y: number; z: number }[]): number {
  const buckets = bucketGravity(rows, 300);
  let changes = 0;
  for (let i = 1; i < buckets.length; i++) {
    const a = buckets[i - 1], b = buckets[i];
    if (Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5 || Math.abs(a.z - b.z) > 0.5) changes++;
  }
  return changes;
}

// stepSample.counter is the WHOOP step_motion_counter@57 raw stream: a CUMULATIVE u16 counter that
// climbs while moving, holds while still, and wraps at 65536 — NOT a per-sample step count. This
// ports Packages/StrandAnalytics/AnalyticsEngine.swift's stepsTotal algorithm verbatim (minus the
// user-calibrated stepTicksPerStep scale, unavailable to the mirror — default 1.0 is a pass-through
// so omitting it matches an uncalibrated profile exactly): per device, time order, delta = (cur -
// prev) & 0xFFFF (wrap-aware), keep only 1 <= delta < 512 (>=512 is a sync-session gap or firmware
// reboot, not real motion — byte-indistinguishable from a wrap, so this is an approximation), and
// the first sample per device has no predecessor and contributes nothing.
const MAX_STEP_DELTA = 512;
// activityClass rides through each returned delta as the ENDING sample's class (see classifyTicks
// below for why the ending sample, not the starting one, owns the delta).
function stepDeltas(rows: { deviceId: string; ts: number; counter: number; activityClass?: number | null }[]): { deviceId: string; ts: number; delta: number; activityClass: number | null }[] {
  const byDevice = new Map<string, { ts: number; counter: number; activityClass: number | null }[]>();
  for (const r of rows) {
    const arr = byDevice.get(r.deviceId) ?? [];
    arr.push({ ts: r.ts, counter: r.counter, activityClass: r.activityClass ?? null });
    byDevice.set(r.deviceId, arr);
  }
  const out: { deviceId: string; ts: number; delta: number; activityClass: number | null }[] = [];
  for (const [deviceId, arr] of byDevice) {
    arr.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < arr.length; i++) {
      const delta = (arr[i].counter - arr[i - 1].counter) & 0xFFFF;
      if (delta >= 1 && delta < MAX_STEP_DELTA) out.push({ deviceId, ts: arr[i].ts, delta, activityClass: arr[i].activityClass });
    }
  }
  return out;
}

// stepSample.activityClass is the strap's per-record @63 activity-class enum (community finding
// #316, ported from Packages/WhoopProtocol/Sources/WhoopProtocol/Streams.swift in the NOOP app repo):
// 0=still, 1=walk, 2=run, null when the byte was invalid/absent or the row predates the v19/(Android
// v13) migration that added the column. The app itself never attributes activityClass at delta
// granularity — its only consumer (Repository.swift's stepActivityClassLatest) picks the single
// latest non-null class over a whole day for one icon — so there is no app-side "which sample owns a
// multi-sample delta" convention to port. This function's choice, not a mirrored one: each wrap-aware
// delta's tick count is attributed to the class of the sample ENDING that delta (arr[i], not
// arr[i-1]), since that's the sample whose motion the counter distance actually measures up to.
function classifyTicks(deltas: { delta: number; activityClass: number | null }[]): { walkTicks: number; runTicks: number; stillTicks: number; unclassifiedTicks: number } {
  let walkTicks = 0, runTicks = 0, stillTicks = 0, unclassifiedTicks = 0;
  for (const d of deltas) {
    if (d.activityClass === 1) walkTicks += d.delta;
    else if (d.activityClass === 2) runTicks += d.delta;
    else if (d.activityClass === 0) stillTicks += d.delta;
    else unclassifiedTicks += d.delta;
  }
  return { walkTicks, runTicks, stillTicks, unclassifiedTicks };
}

export function hrSeries(cfg: Config, args: { from: string; to: string; deviceId?: string; bucketSeconds?: number }) {
  if (!fs.existsSync(cfg.mirrorPath)) return { samples: [], notIngested: true };
  const fromTs = toTs(args.from), toT = toTs(args.to, true);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toT)) return { error: "bad_range" };
  if (toT - fromTs > MAX_SPAN_S) return { error: "span_too_wide", maxDays: 7 };
  const ranges = computeOverlay(cfg).deletedHrRanges;
  const m = new Mirror(cfg.mirrorPath);
  try {
    const raw = dropDeleted(m.hrSamplesRange({ fromTs, toTs: toT, deviceId: args.deviceId, limit: 200_000 }), ranges);
    if (args.bucketSeconds) {
      const b = Math.min(3600, Math.max(60, args.bucketSeconds));
      const byBucket = new Map<string, { ts: number; deviceId: string; sum: number; min: number; max: number; n: number }>();
      for (const s of raw) {
        const key = `${s.deviceId}|${Math.floor(s.ts / b) * b}`;
        const cur = byBucket.get(key) ?? { ts: Math.floor(s.ts / b) * b, deviceId: s.deviceId, sum: 0, min: s.bpm, max: s.bpm, n: 0 };
        cur.sum += s.bpm; cur.min = Math.min(cur.min, s.bpm); cur.max = Math.max(cur.max, s.bpm); cur.n += 1;
        byBucket.set(key, cur);
      }
      const buckets = [...byBucket.values()].sort((a, b2) => a.ts - b2.ts)
        .map((x) => ({ ts: x.ts, avg: Math.round((x.sum / x.n) * 10) / 10, min: x.min, max: x.max, n: x.n, deviceId: x.deviceId, family: sourceFamily(x.deviceId) }));
      return { buckets };
    }
    const capped = raw.slice(0, RAW_CAP);
    return { samples: capped.map((s) => ({ ...s, family: sourceFamily(s.deviceId) })), ...(raw.length > RAW_CAP ? { truncated: true, hint: "pass bucketSeconds to aggregate" } : {}) };
  } finally { m.close(); }
}

// hrvSeries' RR cleaning — a LIGHT approximation of the app's HRVAnalyzer cleaning intent
// (Packages/StrandAnalytics/Sources/StrandAnalytics/HRVAnalyzer.swift in the NOOP app repo: a
// [300,2000]ms range filter + Malik-style centered-5-beat-window ectopic rejection, then a
// minBeats(20) gate before trusting RMSSD). This cloud tool is not the on-device scoring engine and
// isn't bound by the app's Swift/Kotlin byte-parity contract, so it trades precision for a single
// linear pass: a wider [250,3000]ms range gate, and a both-neighbors successive-diff spike check
// instead of a centered local-median window. minBeats(20) is reused as-is since it's the app's own
// "trustworthy result" threshold.
const RR_MIN_MS = 250, RR_MAX_MS = 3000;
const RR_ECTOPIC_THRESHOLD = 0.20;
const RR_MIN_BEATS = 20;

// Range filter, then a both-neighbors successive-diff spike check: an interior beat is dropped only
// when it deviates from BOTH its previous and next range-surviving beat by more than
// RR_ECTOPIC_THRESHOLD — an isolated bad beat between two normal ones, not a real change in rhythm.
// Boundary beats (no previous or no next survivor) are always kept: light filtering defers to
// inclusion rather than risking a false rejection with only one neighbor to judge against.
// Order-preserving; input must already be ts-sorted (rrIntervalsRange guarantees this).
function cleanRR(rows: { ts: number; rrMs: number }[]): { ts: number; rrMs: number }[] {
  const ranged = rows.filter((r) => r.rrMs >= RR_MIN_MS && r.rrMs <= RR_MAX_MS);
  const keep = new Array(ranged.length).fill(true);
  for (let i = 1; i < ranged.length - 1; i++) {
    const prev = ranged[i - 1].rrMs, cur = ranged[i].rrMs, next = ranged[i + 1].rrMs;
    const devPrev = Math.abs(cur - prev) / prev, devNext = Math.abs(cur - next) / next;
    if (devPrev > RR_ECTOPIC_THRESHOLD && devNext > RR_ECTOPIC_THRESHOLD) keep[i] = false;
  }
  return ranged.filter((_, i) => keep[i]);
}

export function hrvSeries(cfg: Config, args: { from: string; to: string; deviceId?: string; bucketSeconds?: number }) {
  if (!fs.existsSync(cfg.mirrorPath)) return { buckets: [], notIngested: true };
  const fromTs = toTs(args.from), toT = toTs(args.to, true);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toT)) return { error: "bad_range" };
  if (toT - fromTs > MAX_SPAN_S) return { error: "span_too_wide", maxDays: 7 };
  const b = Math.min(3600, Math.max(60, args.bucketSeconds ?? 300));
  const m = new Mirror(cfg.mirrorPath);
  try {
    const raw = m.rrIntervalsRange({ fromTs, toTs: toT, deviceId: args.deviceId, limit: RR_RAW_CAP });
    // rrInterval is WHOOP-era only — the Oura API never exposed beat-to-beat timing, so a range that's
    // pure oura-api (or predates any WHOOP pairing) legitimately has zero rows, not a bug. Distinguish
    // that from "no data in this bucket" (which still returns a bucket, just with rmssd:null below).
    if (raw.length === 0) {
      return { buckets: [], rrAvailable: false, hint: "rrInterval is WHOOP-era only — empty for oura-api and any pre-WHOOP range (the Oura API never provides beat-to-beat R-R data)." };
    }
    const byBucket = new Map<string, { ts: number; deviceId: string; rows: { ts: number; rrMs: number }[] }>();
    for (const r of raw) {
      const bucketTs = Math.floor(r.ts / b) * b;
      const key = `${r.deviceId}|${bucketTs}`;
      let c = byBucket.get(key);
      if (!c) { c = { ts: bucketTs, deviceId: r.deviceId, rows: [] }; byBucket.set(key, c); }
      c.rows.push({ ts: r.ts, rrMs: r.rrMs });
    }
    const buckets = [...byBucket.values()].sort((x, y) => x.ts - y.ts || x.deviceId.localeCompare(y.deviceId))
      .map((c) => {
        const clean = cleanRR(c.rows);
        const n = clean.length;
        // Too few clean beats to trust RMSSD/meanHr (same minBeats floor as the app's HRVAnalyzer) —
        // null, not a fabricated number, while still reporting n so a caller can see how close it was.
        if (n < RR_MIN_BEATS) return { ts: c.ts, deviceId: c.deviceId, family: sourceFamily(c.deviceId), rmssd: null, meanHr: null, n };
        let sumSq = 0;
        for (let i = 1; i < n; i++) { const d = clean[i].rrMs - clean[i - 1].rrMs; sumSq += d * d; }
        const rmssd = round1(Math.sqrt(sumSq / (n - 1))); // Task Force (1996) RMSSD — matches HRVAnalyzer.rmssdRaw
        const meanRR = clean.reduce((s, r) => s + r.rrMs, 0) / n;
        const meanHr = round1(60_000 / meanRR); // 60,000ms/min ÷ mean RR(ms) = beats/min
        return { ts: c.ts, deviceId: c.deviceId, family: sourceFamily(c.deviceId), rmssd, meanHr, n };
      });
    return { buckets, ...(raw.length === RR_RAW_CAP ? { truncated: true, hint: "narrow the from/to window or increase bucketSeconds" } : {}) };
  } finally { m.close(); }
}

export function sleepDetail(cfg: Config, args: { deviceId: string; startTs: number }) {
  if (!fs.existsSync(cfg.mirrorPath)) return { notIngested: true };
  const overlay = computeOverlay(cfg);
  const m = new Mirror(cfg.mirrorPath);
  try {
    const row = m.sleepSessionAt(args.deviceId, args.startTs);
    if (!row) return { notFound: true };
    const adj = overlay.sleepBounds.get(sleepKeyOf(args.deviceId, args.startTs));
    const startTs = adj?.newStartTs ?? row.startTs, endTs = adj?.newEndTs ?? row.endTs;
    const stageEdit = overlay.stageEdits.get(sleepKeyOf(args.deviceId, args.startTs));
    const stages = stageEdit ? stageEdit.stages : (row.stagesJSON ? JSON.parse(row.stagesJSON) : null);
    const hr = dropDeleted(m.hrSamplesRange({ fromTs: startTs, toTs: endTs, deviceId: args.deviceId, limit: HR_DETAIL_RAW_CAP }), overlay.deletedHrRanges);
    const hrAny = hr.length ? hr : dropDeleted(m.hrSamplesRange({ fromTs: startTs, toTs: endTs, limit: HR_DETAIL_RAW_CAP }), overlay.deletedHrRanges);
    const hrDec = decimateEvenly(hrAny, RAW_CAP);
    // stepSample/gravitySample are absent from any mirror ingested before this feature shipped —
    // motion stays null rather than a misleading all-zero reading in that case.
    const hasMotion = m.hasTable("stepSample") || m.hasTable("gravitySample");
    // Same device-lineage split as hr/hrAny above: real mirrors carry a session's SCORED sleepSession
    // row under one deviceId (e.g. "my-whoop-noop") while the RAW motion streams are tagged under a
    // sibling deviceId (e.g. "my-whoop") — confirmed against the live production mirror, where a
    // strict args.deviceId filter here silently reads as "no motion" for every real session instead
    // of falling back to whatever device actually carries the raw stream in this time window.
    const stepsOwn = m.stepSamplesRange({ fromTs: startTs, toTs: endTs, deviceId: args.deviceId, limit: MOTION_RAW_CAP });
    const stepsAny = stepsOwn.length ? stepsOwn : m.stepSamplesRange({ fromTs: startTs, toTs: endTs, limit: MOTION_RAW_CAP });
    const gravityOwn = m.gravitySamplesRange({ fromTs: startTs, toTs: endTs, deviceId: args.deviceId, limit: MOTION_RAW_CAP });
    const gravityAny = gravityOwn.length ? gravityOwn : m.gravitySamplesRange({ fromTs: startTs, toTs: endTs, limit: MOTION_RAW_CAP });
    const deltasAny = stepDeltas(stepsAny);
    const motion = hasMotion ? {
      steps: deltasAny.reduce((sum, d) => sum + d.delta, 0),
      ...classifyTicks(deltasAny),
      postureChanges: countPostureChanges(gravityAny),
      // Either read landing exactly on the cap means it was clipped, not necessarily complete — see
      // MOTION_RAW_CAP above for the sizing rationale.
      ...(stepsAny.length === MOTION_RAW_CAP || gravityAny.length === MOTION_RAW_CAP ? { truncated: true } : {}),
    } : null;
    return {
      session: { deviceId: row.deviceId, family: sourceFamily(row.deviceId), startTs, endTs, durationMin: Math.round((endTs - startTs) / 60), efficiency: row.efficiency, restingHr: row.restingHr, avgHrv: row.avgHrv, ...(adj ? { edited: true, editId: adj.editId } : {}) },
      stages, ...(stageEdit ? { stagesEdited: true, editId: stageEdit.editId } : {}),
      hrDuringSleep: hrDec.rows.map((s) => ({ ts: s.ts, bpm: s.bpm, deviceId: s.deviceId })),
      ...(hrDec.decimated ? { hrDecimated: true, hrStride: hrDec.stride, hrTotalSamples: hrDec.total } : {}),
      motion,
    };
  } finally { m.close(); }
}

export function motionSeries(cfg: Config, args: { from: string; to: string; deviceId?: string; bucketSeconds?: number }) {
  if (!fs.existsSync(cfg.mirrorPath)) return { buckets: [], notIngested: true };
  const fromTs = toTs(args.from), toT = toTs(args.to, true);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toT)) return { error: "bad_range" };
  if (toT - fromTs > MAX_SPAN_S) return { error: "span_too_wide", maxDays: 7 };
  const b = Math.min(3600, Math.max(60, args.bucketSeconds ?? 300));
  // appleStepHour rows are hour-granular (ts = hour-start, one pre-aggregated steps total per hour) —
  // a caller explicitly filtered to apple-health with a sub-hour bucket can't get a meaningful answer
  // (every bucket would just echo one hour's total, or be empty), so this rejects rather than silently
  // returning a misleading result. An unfiltered caller with a sub-hour bucket instead falls through
  // and omits apple rows (see appleOmitted below) since strap data at that bucket size is still valid.
  if (args.deviceId === "apple-health" && b < 3600) {
    return { error: "apple_hourly_min_bucket", hint: "appleStepHour data is hourly; use bucketSeconds >= 3600" };
  }
  const wantsApple = args.deviceId === "apple-health" || args.deviceId === undefined;
  const m = new Mirror(cfg.mirrorPath);
  try {
    const stepsRaw = m.stepSamplesRange({ fromTs, toTs: toT, deviceId: args.deviceId, limit: SERIES_CAP });
    const deltas = stepDeltas(stepsRaw);
    const gravity = m.gravitySamplesRange({ fromTs, toTs: toT, deviceId: args.deviceId, limit: SERIES_CAP });
    type Cell = { ts: number; deviceId: string; steps: number; walkTicks: number; runTicks: number; stillTicks: number; unclassifiedTicks: number; n: number; gx: number[]; gy: number[]; gz: number[] };
    const byBucket = new Map<string, Cell>();
    const cellFor = (deviceId: string, ts: number) => {
      const bucketTs = Math.floor(ts / b) * b;
      const key = `${deviceId}|${bucketTs}`;
      let c = byBucket.get(key);
      if (!c) { c = { ts: bucketTs, deviceId, steps: 0, walkTicks: 0, runTicks: 0, stillTicks: 0, unclassifiedTicks: 0, n: 0, gx: [], gy: [], gz: [] }; byBucket.set(key, c); }
      return c;
    };
    // Every raw stepSample row is motion evidence (bucket presence + n), even when its own delta
    // isn't computable (first sample per device); the wrap-aware deltas separately add to `steps` and,
    // per classifyTicks above, to exactly one of walkTicks/runTicks/stillTicks/unclassifiedTicks (the
    // four always sum to `steps`).
    for (const s of stepsRaw) { const c = cellFor(s.deviceId, s.ts); c.n += 1; }
    for (const d of deltas) {
      const c = cellFor(d.deviceId, d.ts);
      c.steps += d.delta;
      if (d.activityClass === 1) c.walkTicks += d.delta;
      else if (d.activityClass === 2) c.runTicks += d.delta;
      else if (d.activityClass === 0) c.stillTicks += d.delta;
      else c.unclassifiedTicks += d.delta;
    }
    for (const g of gravity) { const c = cellFor(g.deviceId, g.ts); c.gx.push(g.x); c.gy.push(g.y); c.gz.push(g.z); c.n += 1; }
    const avg = (xs: number[]) => round3(xs.reduce((a, x) => a + x, 0) / xs.length);
    const spread = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
    const strapBuckets = [...byBucket.values()]
      .map((x) => ({
        ts: x.ts, deviceId: x.deviceId, family: sourceFamily(x.deviceId), steps: x.steps,
        walkTicks: x.walkTicks, runTicks: x.runTicks, stillTicks: x.stillTicks, unclassifiedTicks: x.unclassifiedTicks,
        ...(x.gx.length ? { postureX: avg(x.gx), postureY: avg(x.gy), postureZ: avg(x.gz), postureVar: round3((spread(x.gx) + spread(x.gy) + spread(x.gz)) / 3) } : {}),
        n: x.n,
      }));
    // iPhone hourly steps overlay (appleStepHour, NOOP commit d47525ea): only meaningful at
    // bucketSeconds >= 3600 (see the apple_hourly_min_bucket early-return above for the
    // apple-health-filtered case). An unfiltered caller with a finer bucket still gets full strap
    // data — apple rows are just left out, flagged via appleOmitted so the caller knows why iPhone
    // data isn't there rather than assuming the phone recorded nothing. Built as separate bucket
    // objects (not through cellFor/Cell) rather than zero-filled tick/posture fields, since apple rows
    // carry neither activity-class nor gravity evidence.
    let appleOmitted = false;
    const appleBucketsByTs = new Map<number, { steps: number; n: number; deviceId: string }>();
    if (wantsApple) {
      if (b >= 3600) {
        for (const row of m.appleStepHours(fromTs, toT)) {
          const bucketTs = row.ts;
          const cur = appleBucketsByTs.get(bucketTs) ?? { steps: 0, n: 0, deviceId: row.deviceId };
          cur.steps += row.steps; cur.n += 1;
          appleBucketsByTs.set(bucketTs, cur);
        }
      } else {
        appleOmitted = true;
      }
    }
    const appleBuckets = [...appleBucketsByTs.entries()]
      .map(([ts, v]) => ({ ts, deviceId: v.deviceId, family: sourceFamily(v.deviceId), steps: v.steps, n: v.n }));
    const buckets = [...strapBuckets, ...appleBuckets].sort((a, c) => a.ts - c.ts || a.deviceId.localeCompare(c.deviceId));
    // Either source read landing exactly on SERIES_CAP means it was clipped — a wide window with dense
    // motion (see SERIES_CAP above) — so later buckets in the range may be missing entirely.
    return {
      buckets,
      ...(stepsRaw.length === SERIES_CAP || gravity.length === SERIES_CAP ? { truncated: true, hint: "narrow the from/to window or increase bucketSeconds" } : {}),
      ...(appleOmitted ? { appleOmitted: true } : {}),
    };
  } finally { m.close(); }
}

// imu_series: bucket the per-second WHOOP 5/MG IMU activity features (WhoopStore v28 imuActivity table)
// over a range. Structurally like motionSeries but reads one derived-feature table (not step+gravity),
// and — since IMU capture is 5/MG-only + opt-in — degrades to notCaptured on a mirror lacking the table.
// Cadence is aggregated as a STRENGTH-WEIGHTED mean over the rhythmic seconds (nulls ignored), so a
// bucket with only a few clean gait seconds isn't dragged to a fabricated rate by the still ones; per
// the derived-signal rule cadence is a reported feature, never a gate.
export function imuSeries(cfg: Config, args: { from: string; to: string; deviceId?: string; bucketSeconds?: number }) {
  if (!fs.existsSync(cfg.mirrorPath)) return { buckets: [], notIngested: true };
  const fromTs = toTs(args.from), toT = toTs(args.to, true);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toT)) return { error: "bad_range" };
  if (toT - fromTs > MAX_SPAN_S) return { error: "span_too_wide", maxDays: 7 };
  const b = Math.min(3600, Math.max(60, args.bucketSeconds ?? 300));
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const m = new Mirror(cfg.mirrorPath);
  try {
    if (!m.hasTable("imuActivity")) {
      return { buckets: [], notCaptured: true, hint: "no IMU activity — needs a WHOOP 5/MG with the deep-buffer capture toggle on" };
    }
    const rows = m.imuActivityRange({ fromTs, toTs: toT, deviceId: args.deviceId, limit: SERIES_CAP });
    type Cell = { ts: number; deviceId: string; accelSum: number; accelPeak: number; gyroSum: number; jerkSum: number; cadWeightSum: number; cadValSum: number; rhythmic: number; n: number };
    const byBucket = new Map<string, Cell>();
    for (const row of rows) {
      const bucketTs = Math.floor(row.ts / b) * b;
      const key = `${row.deviceId}|${bucketTs}`;
      let c = byBucket.get(key);
      if (!c) { c = { ts: bucketTs, deviceId: row.deviceId, accelSum: 0, accelPeak: 0, gyroSum: 0, jerkSum: 0, cadWeightSum: 0, cadValSum: 0, rhythmic: 0, n: 0 }; byBucket.set(key, c); }
      c.accelSum += row.accelEnergyG; c.accelPeak = Math.max(c.accelPeak, row.accelEnergyG);
      c.gyroSum += row.gyroEnergyDps; c.jerkSum += row.jerkRms; c.n += 1;
      if (row.cadenceHz != null) { c.rhythmic += 1; c.cadWeightSum += row.cadenceStrength; c.cadValSum += row.cadenceHz * row.cadenceStrength; }
    }
    const buckets = [...byBucket.values()]
      .sort((a, c) => a.ts - c.ts || a.deviceId.localeCompare(c.deviceId))
      .map((c) => {
        const cadenceHz = c.cadWeightSum > 0 ? c.cadValSum / c.cadWeightSum : null;
        return {
          ts: c.ts, deviceId: c.deviceId, family: sourceFamily(c.deviceId), seconds: c.n,
          accelEnergyG: r3(c.accelSum / c.n), accelEnergyPeakG: r3(c.accelPeak),
          gyroEnergyDps: r3(c.gyroSum / c.n), jerkRms: r3(c.jerkSum / c.n),
          cadenceHz: cadenceHz == null ? null : r3(cadenceHz),
          cadenceStepsPerMin: cadenceHz == null ? null : Math.round(cadenceHz * 60),
          rhythmicFraction: r3(c.rhythmic / c.n),
        };
      });
    return { buckets, ...(rows.length === SERIES_CAP ? { truncated: true, hint: "narrow the from/to window or increase bucketSeconds" } : {}) };
  } finally { m.close(); }
}

// battery_series: the paired strap's own battery telemetry (WhoopStore `battery` table) over a range.
// Shaped like hrSeries (raw by default, bucketed only when asked) rather than the always-bucketed
// motion/imu/hrv tools on purpose: the question this exists to answer — "when did it die / start
// charging?" — is about TRANSITIONS, and a bucket average blurs the exact edge the caller wants.
//
// soc is PERCENT (0-100) with one real decimal, mv is cell millivolts — see batterySamplesRange in
// src/mirror.ts for the provenance of that (it is confirmed against the app-side producer, not assumed).
//
// soc, mv and charging are ALL nullable columns, so nulls pass through as null and are SKIPPED by the
// bucket aggregates rather than coerced to 0 — a 0 here would read as "flat battery", which is exactly
// the false alarm this tool exists to resolve. charging in particular is null on the whole
// command-response path (only the dense BATTERY_LEVEL-event path reports it, WhoopStore migration v6),
// so null means UNKNOWN, never "not charging".
const asBool = (v: number | null | undefined) => (v == null ? null : !!v);

export function batterySeries(cfg: Config, args: { from: string; to: string; deviceId?: string; bucketSeconds?: number }) {
  // Mode-appropriate empty payload, so a bucketSeconds caller isn't handed a `samples` key (and vice
  // versa) on the no-data paths below.
  const empty = args.bucketSeconds ? { buckets: [] as unknown[] } : { samples: [] as unknown[] };
  if (!fs.existsSync(cfg.mirrorPath)) return { ...empty, notIngested: true };
  const fromTs = toTs(args.from), toT = toTs(args.to, true);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toT)) return { error: "bad_range" };
  if (toT - fromTs > MAX_SPAN_S) return { error: "span_too_wide", maxDays: 7 };
  const m = new Mirror(cfg.mirrorPath);
  try {
    const raw = m.batterySamplesRange({ fromTs, toTs: toT, deviceId: args.deviceId, limit: SERIES_CAP });
    // Zero readings is a RESULT, not an error, and it's the tool's most diagnostic answer — the strap
    // reported nothing across the whole window. Say so instead of returning an empty series a caller
    // could read as "battery fine". Covers both a mirror with no battery table at all (older/foreign
    // upload — batterySamplesRange returns [] for that) and a real table with nothing in range.
    if (raw.length === 0) {
      return { ...empty, notCaptured: true, hint: "no battery readings in range — the strap reported none: dead, off wrist, unpaired, or out of BLE range for the whole window (or the phone never synced it). Absence is evidence, not an error: call data_freshness to tell 'strap was silent' from 'phone hasn't uploaded'." };
    }
    const last = raw[raw.length - 1];
    // The most recent reading INSIDE [from,to] — deliberately not called "current": the mirror only
    // holds what the phone last uploaded. Carries its own deviceId so it stays unambiguous on a
    // multi-strap mirror.
    const latest = { ts: last.ts, deviceId: last.deviceId, family: sourceFamily(last.deviceId), soc: last.soc, mv: last.mv, charging: asBool(last.charging) };
    // Landing exactly on the cap means the read was clipped — later readings in the range may be gone.
    const truncated = raw.length === SERIES_CAP ? { truncated: true, hint: "narrow the from/to window" } : {};
    if (args.bucketSeconds) {
      const b = Math.min(3600, Math.max(60, args.bucketSeconds));
      type Cell = { ts: number; deviceId: string; socs: number[]; mvs: number[]; chargingTrue: number; chargingKnown: number; n: number };
      const byBucket = new Map<string, Cell>();
      for (const r of raw) {
        const bucketTs = Math.floor(r.ts / b) * b;
        const key = `${r.deviceId}|${bucketTs}`;
        let c = byBucket.get(key);
        if (!c) { c = { ts: bucketTs, deviceId: r.deviceId, socs: [], mvs: [], chargingTrue: 0, chargingKnown: 0, n: 0 }; byBucket.set(key, c); }
        if (r.soc != null) c.socs.push(r.soc);
        if (r.mv != null) c.mvs.push(r.mv);
        if (r.charging != null) { c.chargingKnown += 1; if (r.charging) c.chargingTrue += 1; }
        c.n += 1;
      }
      // raw is ORDER BY ts, so per-bucket push order is time order: [0] is first, at() is last.
      const buckets = [...byBucket.values()]
        .sort((a, c) => a.ts - c.ts || a.deviceId.localeCompare(c.deviceId))
        .map((c) => ({
          ts: c.ts, deviceId: c.deviceId, family: sourceFamily(c.deviceId),
          // first/last carry the DIRECTION within the bucket (falling = discharge, rising = charge);
          // null only when every reading in the bucket had a null soc.
          socFirst: c.socs.length ? c.socs[0] : null,
          socLast: c.socs.length ? c.socs[c.socs.length - 1] : null,
          socMin: c.socs.length ? Math.min(...c.socs) : null,
          socMax: c.socs.length ? Math.max(...c.socs) : null,
          mvLast: c.mvs.length ? c.mvs[c.mvs.length - 1] : null,
          // Three-state, honouring the nullability above: true if ANY reading in the bucket reported
          // charging, false if every reporting reading said no, null if NONE reported (unknown).
          charging: c.chargingKnown === 0 ? null : c.chargingTrue > 0,
          n: c.n,
        }));
      return { buckets, latest, ...truncated };
    }
    // Even decimation, not a head slice: past the cap a head slice would return the START of the window
    // and silently drop the tail — i.e. exactly the moment the battery died. Same correction (and the
    // same helper) as sleepDetail's hrDuringSleep read; see HR_DETAIL_RAW_CAP above for the live
    // investigation that one misled. In practice battery readings are far too sparse to reach this.
    const dec = decimateEvenly(raw, RAW_CAP);
    return {
      samples: dec.rows.map((r) => ({ ts: r.ts, deviceId: r.deviceId, family: sourceFamily(r.deviceId), soc: r.soc, mv: r.mv, charging: asBool(r.charging) })),
      latest,
      ...(dec.decimated ? { decimated: true, stride: dec.stride, totalSamples: dec.total, hint: "evenly thinned across the window — exact transition timing may be lost; narrow the range for it" } : {}),
      ...truncated,
    };
  } finally { m.close(); }
}

// device_events: the STRAP's own firmware event log (WhoopStore `event` table) over a range — the
// wear/charge/boot/connection transitions the strap itself reported, as opposed to anything the phone
// or the analytics inferred. This is the DB-backed half of "is my strap healthy and capturing?".
//
// `kind` is always "LABEL(opcode)" or "0xNN(opcode)" — never a bare label; see eventsRange in
// src/mirror.ts for the provenance (WhoopProtocol Schema.enumName builds it). Rather than make callers
// carry that quirk, each event is returned with `kind` verbatim PLUS a parsed `label` and `opcode`, and
// the `kinds` filter accepts either spelling.
const KIND_RE = /^(.*)\((\d+)\)$/;
function splitKind(kind: string): { label: string; opcode: number | null } {
  // Greedy (.*) so the split is on the LAST "(", which is the opcode group Schema.enumName appends.
  const m = KIND_RE.exec(kind);
  return m ? { label: m[1], opcode: Number(m[2]) } : { label: kind, opcode: null };
}
// payloadJSON is TEXT NOT NULL and is "{}" for all but one kind on a real mirror (of VK's 11 457 live
// rows only BATTERY_LEVEL(3) carries fields), so an always-present `payload: {}` would be pure noise on
// thousands of rows. Omit it when empty; keep it verbatim when it isn't. A payload that won't parse is
// surfaced as payloadRaw rather than dropped or guessed at.
function parsePayload(json: string): { payload?: unknown; payloadRaw?: string } {
  if (!json || json === "{}") return {};
  try {
    const p = JSON.parse(json);
    if (p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 0) return {};
    return { payload: p };
  } catch { return { payloadRaw: json }; }
}

export function deviceEvents(cfg: Config, args: { from: string; to: string; deviceId?: string; kinds?: string[]; countsOnly?: boolean }) {
  const empty = { counts: [] as unknown[], ...(args.countsOnly ? {} : { events: [] as unknown[] }) };
  if (!fs.existsSync(cfg.mirrorPath)) return { ...empty, notIngested: true };
  const fromTs = toTs(args.from), toT = toTs(args.to, true);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toT)) return { error: "bad_range" };
  if (toT - fromTs > MAX_SPAN_S) return { error: "span_too_wide", maxDays: 7 };
  const m = new Mirror(cfg.mirrorPath);
  try {
    // Counts first and from their own SQL aggregate: they stay TRUE even when the event read below is
    // capped (see eventKindCounts in src/mirror.ts).
    const counts = m.eventKindCounts({ fromTs, toTs: toT, deviceId: args.deviceId, kinds: args.kinds })
      .map((c) => ({ kind: c.kind, ...splitKind(c.kind), n: c.n, firstTs: c.firstTs, lastTs: c.lastTs }));
    if (counts.length === 0) {
      // Zero events is a RESULT and a diagnostic one: the strap reported nothing across the window.
      // Covers a mirror with no `event` table (older/foreign upload), a real table with nothing in
      // range, and a `kinds` filter that matched nothing — the hint names all three so a caller can
      // tell "strap was silent" from "I filtered myself to nothing".
      return { ...empty, notCaptured: true, hint: "no strap events in range — either the strap reported none (unpaired, dead, off wrist, or out of BLE range for the whole window, or the phone never synced), or `kinds` filtered everything out. Cloud-imported sources (oura-api) NEVER write events, so an events question about one is always empty. Call data_freshness to tell 'strap was silent' from 'phone hasn't uploaded'." };
    }
    if (args.countsOnly) return { counts };
    const rows = m.eventsRange({ fromTs, toTs: toT, deviceId: args.deviceId, kinds: args.kinds, limit: RAW_CAP });
    const events = rows.map((r) => ({ ts: r.ts, deviceId: r.deviceId, family: sourceFamily(r.deviceId), kind: r.kind, ...splitKind(r.kind), ...parsePayload(r.payloadJSON) }));
    const last = rows[rows.length - 1];
    const latest = { ts: last.ts, deviceId: last.deviceId, family: sourceFamily(last.deviceId), kind: last.kind, ...splitKind(last.kind) };
    // Head-slice + a loud flag, NOT battery_series' even decimation: an event log is discrete, and
    // thinning it would drop whole one-off kinds — the BOOT or RTC_LOST a caller is hunting is exactly
    // the row a stride would skip. `counts` above already tells the truth about the whole range, so the
    // honest shape is a contiguous prefix plus "there are more".
    const truncated = rows.length === RAW_CAP
      ? { truncated: true, hint: "only the first 5000 events in range are listed — `counts` is still complete for the whole window; narrow from/to or pass `kinds` to see the rest" }
      : {};
    return { counts, events, latest, ...truncated };
  } finally { m.close(); }
}

// imu_coverage: WHERE the deep IMU buffers exist, not what they say — the availability question
// imu_series can't answer without blind-scanning ranges. Answers "did my overnight capture actually
// work?" in one call, and with from/to omitted, "do I have ANY deep buffers, ever?".
//
// Rows in imuActivity are ONE PER SECOND (WhoopStore ImuActivityStore.swift: "One second's worth of
// IMU-derived activity features", and the live mirror agrees — 2941 of 2944 adjacent gaps are exactly
// 1 s). That is what makes a row count meaningful as `seconds` and coverage a real ratio rather than a
// guess.
//
// Reported as contiguous SESSIONS rather than per-day buckets on purpose: a capture run is the natural
// unit of "did it work", and sessions are timezone-independent — a UTC-day roll-up would split an
// overnight at a boundary that means nothing to the wearer (and the phone's tz is per-day metadata this
// table has no claim on).
const IMU_COVERAGE_MAX_SPAN_S = 366 * 86_400;
const IMU_COVERAGE_CAP = 1_000_000;

export function imuCoverage(cfg: Config, args: { from?: string; to?: string; deviceId?: string; gapSeconds?: number }) {
  if (!fs.existsSync(cfg.mirrorPath)) return { sessions: [], notIngested: true };
  const m = new Mirror(cfg.mirrorPath);
  try {
    if (!m.hasTable("imuActivity")) {
      return { sessions: [], notCaptured: true, hint: "no imuActivity table — this mirror predates the WhoopStore v28-imu-activity migration, so the phone build that uploaded it could not record deep IMU buffers at all. Needs a WHOOP 5/MG on a build carrying that migration, with the deep-buffer capture toggle on." };
    }
    // With no window, anchor on the table's own extent: "do I have buffers at all?" shouldn't require
    // guessing a range — which is the exact blind-scanning this tool exists to remove.
    const extent = m.imuActivityExtent(args.deviceId);
    if (!extent) {
      return { sessions: [], notCaptured: true, hint: "imuActivity table exists but is EMPTY — the build supports deep IMU capture and no buffer was ever banked: the capture toggle was off, the strap is a WHOOP 4.0 (5/MG-only feature), or no offload burst has been decoded yet." };
    }
    const fromTs = args.from ? toTs(args.from) : extent.firstTs;
    const toT = args.to ? toTs(args.to, true) : extent.lastTs;
    if (!Number.isFinite(fromTs) || !Number.isFinite(toT)) return { error: "bad_range" };
    // A far wider cap than the 7-day series tools: this reads five narrow columns and returns one row
    // per capture RUN, so "have I ever captured anything?" over a year is a fair question here in a way
    // it isn't for hr_series. Still bounded — an unbounded window is a mistake, not a feature.
    if (toT - fromTs > IMU_COVERAGE_MAX_SPAN_S) return { error: "span_too_wide", maxDays: 366 };
    // A gap longer than this ENDS a session. Default 60 s: deep capture lands one row per second, so a
    // minute of silence is a real dropout, not jitter — reporting two honest runs beats one run with an
    // invented hole bridged across it.
    const gap = Math.min(86_400, Math.max(1, args.gapSeconds ?? 60));
    const rows = m.imuCoverageRange({ fromTs, toTs: toT, deviceId: args.deviceId, limit: IMU_COVERAGE_CAP });
    if (rows.length === 0) {
      return { sessions: [], notCaptured: true, window: { fromTs, toTs: toT }, dataExtent: { firstTs: extent.firstTs, lastTs: extent.lastTs, seconds: extent.n }, hint: "no IMU buffers in THIS range, though the mirror holds some elsewhere — see dataExtent for where they actually are, or call with no from/to to see every capture run." };
    }
    type S = { deviceId: string; startTs: number; endTs: number; seconds: number; samples: number; rhythmic: number; accelPeak: number; gaps: number; largestGap: number };
    const sessions: S[] = [];
    let cur: S | null = null;
    // rows are ORDER BY deviceId, ts — so a device change starts a new session as surely as a time gap.
    for (const r of rows) {
      if (!cur || cur.deviceId !== r.deviceId || r.ts - cur.endTs > gap) {
        cur = { deviceId: r.deviceId, startTs: r.ts, endTs: r.ts, seconds: 0, samples: 0, rhythmic: 0, accelPeak: 0, gaps: 0, largestGap: 0 };
        sessions.push(cur);
      } else {
        // An internal hole: adjacent rows should be 1 s apart, so anything more is missing seconds
        // (but <= gap, or the branch above would have cut a new session).
        const missing = r.ts - cur.endTs - 1;
        if (missing > 0) { cur.gaps += 1; cur.largestGap = Math.max(cur.largestGap, missing); }
      }
      cur.endTs = r.ts; cur.seconds += 1; cur.samples += r.sampleCount;
      if (r.cadenceHz != null) cur.rhythmic += 1;
      cur.accelPeak = Math.max(cur.accelPeak, r.accelEnergyG);
    }
    const out = sessions.map((s) => {
      const spanSeconds = s.endTs - s.startTs + 1;
      return {
        deviceId: s.deviceId, family: sourceFamily(s.deviceId),
        startTs: s.startTs, endTs: s.endTs,
        // ISO alongside the epoch ts (UTC, like every timestamp in the mirror) — this is an
        // observability tool, and "when did my capture run" shouldn't need a second conversion step.
        start: new Date(s.startTs * 1000).toISOString(), end: new Date(s.endTs * 1000).toISOString(),
        seconds: s.seconds, spanSeconds,
        // The headline: seconds banked vs seconds the run spans. < 1 means the capture dropped rows
        // mid-run, which is the failure this tool exists to make visible — so ONLY a genuinely gapless
        // run may report exactly 1. Rounding is clamped rather than trusted: VK's live 2175/2176-second
        // run computes 0.99954, which round3 would hand back as a clean 1.0 while missingSeconds said 1
        // — defeating the `coverage < 1` check this tool's own description tells callers to make.
        coverage: s.seconds === spanSeconds ? 1 : Math.min(round3(s.seconds / spanSeconds), 0.999),
        missingSeconds: spanSeconds - s.seconds,
        gaps: s.gaps, largestGapSeconds: s.largestGap,
        rhythmicSeconds: s.rhythmic,
        // SUM of the per-second sampleCount: how many raw IMU samples the run actually banked.
        samples: s.samples,
        accelEnergyPeakG: round3(s.accelPeak),
      };
    });
    const totalSeconds = out.reduce((a, s) => a + s.seconds, 0);
    return {
      sessions: out,
      totals: {
        sessions: out.length, seconds: totalSeconds,
        samples: out.reduce((a, s) => a + s.samples, 0),
        firstTs: out[0].startTs, lastTs: out[out.length - 1].endTs,
        days: new Set(rows.map((r) => new Date(r.ts * 1000).toISOString().slice(0, 10))).size,
      },
      window: { fromTs, toTs: toT },
      dataExtent: { firstTs: extent.firstTs, lastTs: extent.lastTs, seconds: extent.n },
      ...(rows.length === IMU_COVERAGE_CAP ? { truncated: true, hint: "hit the 1000000-second read cap — later sessions in the range may be missing; narrow from/to" } : {}),
    };
  } finally { m.close(); }
}

export function registerGranularTools(server: McpServer, cfg: Config): void {
  server.registerTool("hr_series", {
    title: "Heart-rate series",
    description: "Raw or bucketed heart-rate samples for a time range (max 7 days). Use to inspect what actually happened (e.g. verify sleep/wake from HR). Reflects confirmed HR deletions.",
    inputSchema: { from: z.string(), to: z.string(), deviceId: z.string().optional(), bucketSeconds: z.number().int().min(60).max(3600).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(hrSeries(cfg, a)));

  server.registerTool("hrv_series", {
    title: "HRV (RMSSD) series from R-R intervals",
    description: "Bucketed heart-rate-variability (RMSSD, ms) computed from raw beat-to-beat R-R intervals for a time range (max 7 days) — the beat-level timing hr_series' averaged BPM can't see, e.g. for daytime HRV or a stress read. R-R data is WHOOP-era only: a range with none returns rrAvailable:false, meaning oura-api or a pre-WHOOP date (the Oura API never exposes beat-to-beat timing). Applies light range (250-3000ms) + successive-diff artifact filtering — a simplified approximation of the app's HRVAnalyzer cleaning, not byte-identical — before computing RMSSD and mean HR (60000/meanRR) per bucket; a bucket with fewer than 20 clean intervals returns rmssd:null and meanHr:null (not fabricated) while still reporting n.",
    inputSchema: { from: z.string(), to: z.string(), deviceId: z.string().optional(), bucketSeconds: z.number().int().min(60).max(3600).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(hrvSeries(cfg, a)));

  server.registerTool("sleep_detail", {
    title: "Sleep night detail",
    description: "One night's full evidence: bounds, stage-by-stage hypnogram, in-sleep heart-rate, and motion (step count + walk/run/still/unclassified tick breakdown + wrist-posture changes) during the session. Reflects confirmed stage edits, bound adjustments, and HR deletions. hrDuringSleep beyond 5000 in-window samples is evenly decimated across the full night rather than truncated to its start (hrDecimated:true plus hrStride/hrTotalSamples record the thinning) — call hr_series directly for a full-resolution window. motion.truncated:true means the raw step/gravity read hit its cap and the count may be incomplete.",
    inputSchema: { deviceId: z.string(), startTs: z.number().int() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(sleepDetail(cfg, a)));

  server.registerTool("motion_series", {
    title: "Motion series",
    description: "Movement evidence for a time range: step counts (+ walk/run/still/unclassified tick breakdown) + wrist posture (gravity) per bucket. Includes iPhone hourly steps (apple-health) when bucketSeconds >= 3600 — overlay against strap ticks to see when the phone was/wasn't recording. Use with hr_series to distinguish 'awake in bed' (no steps, unchanged posture) from 'up and about' (steps, posture change). truncated:true means a wide window with dense motion hit the read cap — narrow the range or widen bucketSeconds.",
    inputSchema: { from: z.string(), to: z.string(), deviceId: z.string().optional(), bucketSeconds: z.number().int().min(60).max(3600).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(motionSeries(cfg, a)));

  server.registerTool("imu_series", {
    title: "IMU activity series (WHOOP 5/MG high-rate motion)",
    description: "High-rate motion for a time range (max 7 days), bucketed: per bucket the mean + peak accelerometer energy (g), gyro energy (°/s), jerk, and gait cadence (Hz + steps/min, strength-weighted over the rhythmic seconds) plus the rhythmic fraction. Derived from the WHOOP 5/MG raw 6-axis IMU offload buffer at 100 Hz — it resolves walking/running cadence, impact and rotational energy that the 1 Hz gravity-only motion_series physically cannot, and is the granular input for sport/activity detection. WHOOP 5/MG only and needs the deep-buffer capture toggle: notCaptured:true means no IMU activity is in range (wrong strap, capture off, or nothing offloaded yet). truncated:true means the read hit its cap — narrow the window or widen bucketSeconds. Pair with hr_series to tell a hard effort (high cadence + high HR) from fidgeting.",
    inputSchema: { from: z.string(), to: z.string(), deviceId: z.string().optional(), bucketSeconds: z.number().int().min(60).max(3600).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(imuSeries(cfg, a)));

  server.registerTool("battery_series", {
    title: "Strap battery series (state-of-charge)",
    description: "The STRAP's own battery for a time range (max 7 days) — raw readings, or per-bucket when bucketSeconds is passed. This is the paired wearable's battery reported over BLE (in practice the WHOOP strap), never the phone's; cloud-imported sources (oura-api) never carry it. soc is PERCENT 0-100 (a real with one decimal, e.g. 82.5 — the strap reports tenths), mv is raw cell millivolts. Answers 'how much battery is left' via `latest`, the most recent reading INSIDE the range — NOT necessarily now, since the mirror only holds what the phone last uploaded, so pair it with data_freshness — and 'when did it die / start charging' by scanning soc for the fall to ~0 or the rise. An ABSENT or FLAT series is the real diagnostic signal, not a bug: notCaptured:true means zero readings in range, i.e. the strap wasn't reporting at all (dead, off wrist, unpaired, or out of BLE range), and a series that simply stops mid-range dates the moment it went quiet. charging is NULLABLE and frequently null: only the dense BATTERY_LEVEL-event path reports it, while the command-response path leaves it null — so charging:null means UNKNOWN, never 'not charging'; infer a charge from rising soc instead. soc/mv are nullable too and pass through as null, never 0. Per bucket: socFirst/socLast (the direction within that bucket), socMin/socMax, mvLast, n, and charging as three-state (true if any reading in the bucket reported charging, false if every reporting reading said no, null if none reported). decimated:true means over 5000 raw readings were evenly thinned across the window, so exact transition timing may be lost — narrow the range to recover it.",
    inputSchema: { from: z.string(), to: z.string(), deviceId: z.string().optional(), bucketSeconds: z.number().int().min(60).max(3600).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(batterySeries(cfg, a)));

  server.registerTool("device_events", {
    title: "Strap firmware event log",
    description: "What the STRAP itself reported for a time range (max 7 days) — the wear/charge/boot/connection log, not anything the phone or the analytics inferred. This is the strap-health tool: WRIST_ON/WRIST_OFF (was it actually worn), CHARGING_ON/CHARGING_OFF and BATTERY_PACK_CONNECTED/REMOVED (on the charger), BLE_CONNECTION_UP/DOWN (was the phone in range to collect), BOOT / BLE_SYSTEM_RESET / RTC_LOST / FLASH_INIT_COMPLETE (the strap rebooted or lost its clock — a prime suspect for missing or mis-timed data), STRAP_CONDITION_REPORT, DOUBLE_TAP, HAPTICS_FIRED. WHOOP-ONLY: cloud-imported sources (oura-api) never write events, so asking about one always returns notCaptured. `kind` is always 'LABEL(opcode)' (e.g. 'WRIST_ON(9)') for events the protocol schema names and '0xNN(opcode)' (e.g. '0x6E(110)') for ones it doesn't — an 0xNN kind is a REAL event whose meaning is simply undecoded, not corruption, and on a live WHOOP 5 these are among the most common. Each event carries `kind` verbatim plus parsed `label` and `opcode`, and the `kinds` filter accepts EITHER spelling ('WRIST_ON' or 'WRIST_ON(9)'). `counts` (per kind, with firstTs/lastTs) is aggregated in SQL over the WHOLE range and is always complete even when the event list is capped — call with countsOnly:true for a cheap 'what happened' glance. PAYLOADS ARE ALMOST ALWAYS EMPTY: payloadJSON is '{}' for every kind except BATTERY_LEVEL(3) (which carries battery_pct/battery_mV/battery_charging), so the `payload` key is OMITTED rather than returned as {} — an event here is usually a bare timestamped fact, and its `kind` is the whole message. Use battery_series for state-of-charge over time; this is for transitions and faults. notCaptured:true means zero events in range — the strap was silent (unpaired, dead, off wrist, out of BLE range) or `kinds` filtered everything out; pair with data_freshness to tell that from 'the phone never uploaded'. truncated:true means over 5000 events matched and only the first 5000 are listed (they are NOT thinned — a stride would drop the one-off BOOT you are hunting); `counts` still covers the full window.",
    inputSchema: {
      from: z.string(), to: z.string(), deviceId: z.string().optional(),
      kinds: z.array(z.string()).optional().describe("Filter to these kinds; accepts a bare label ('WRIST_ON') or the full kind ('WRIST_ON(9)')."),
      countsOnly: z.boolean().optional().describe("Return only the per-kind `counts` summary, not the event list."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(deviceEvents(cfg, a)));

  server.registerTool("imu_coverage", {
    title: "Deep IMU capture coverage",
    description: "WHERE the WHOOP 5/MG deep IMU buffers exist — the availability question imu_series cannot answer without blind-scanning ranges. Answers 'did my overnight capture actually work?' and, with from/to OMITTED (the default, which anchors on the table's own extent), 'do I have ANY deep buffers, ever?'. Returns contiguous capture SESSIONS rather than per-day buckets: a run is the natural unit of 'did it work', and sessions are timezone-independent, so an overnight is never split at a meaningless UTC boundary. Rows in imuActivity are ONE PER SECOND (confirmed against the producer and the live mirror), which is what makes `seconds` a row count and `coverage` a real ratio. Per session: startTs/endTs plus ISO start/end (UTC), `seconds` (seconds actually banked), `spanSeconds` (wall-clock length of the run), `coverage` = seconds/spanSeconds — COVERAGE < 1 IS THE FAILURE SIGNAL, meaning the capture dropped rows mid-run — `missingSeconds`, `gaps` and `largestGapSeconds` (internal holes shorter than gapSeconds), `rhythmicSeconds` (seconds with a cadence lock), `samples` (total raw IMU samples banked), and accelEnergyPeakG. A gap longer than `gapSeconds` (default 60) ENDS a session rather than being bridged, so a dropout shows up as two honest runs, not one run with an invented hole. Span limit is a generous 366 days, unlike the 7-day series tools, because this reads narrow columns and returns one row per run. THREE DISTINCT EMPTY ANSWERS, worth telling apart: notCaptured with a 'predates the migration' hint means the uploading phone build could not capture IMU at all; notCaptured on an EMPTY table means the build supports it but nothing was ever banked (capture toggle off, or a WHOOP 4.0 — this is 5/MG-only); and notCaptured WITH a `dataExtent` means nothing in your range but buffers do exist elsewhere — read dataExtent and retry, or drop from/to. Use imu_series for what the buffers actually say.",
    inputSchema: {
      from: z.string().optional().describe("Omit both from and to to cover every capture run in the mirror."),
      to: z.string().optional(), deviceId: z.string().optional(),
      gapSeconds: z.number().int().min(1).max(86400).optional().describe("A silence longer than this ends a session (default 60)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(imuCoverage(cfg, a)));
}
