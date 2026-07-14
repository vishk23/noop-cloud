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
}
