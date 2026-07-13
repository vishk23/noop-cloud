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
const round3 = (x: number) => Math.round(x * 1000) / 1000;

function dropDeleted(samples: { deviceId: string; ts: number; bpm: number }[], ranges: { deviceId: string; fromTs: number; toTs: number }[]) {
  if (!ranges.length) return samples;
  return samples.filter((s) => !ranges.some((r) => r.deviceId === s.deviceId && s.ts >= r.fromTs && s.ts <= r.toTs));
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
function stepDeltas(rows: { deviceId: string; ts: number; counter: number }[]): { deviceId: string; ts: number; delta: number }[] {
  const byDevice = new Map<string, { ts: number; counter: number }[]>();
  for (const r of rows) {
    const arr = byDevice.get(r.deviceId) ?? [];
    arr.push({ ts: r.ts, counter: r.counter });
    byDevice.set(r.deviceId, arr);
  }
  const out: { deviceId: string; ts: number; delta: number }[] = [];
  for (const [deviceId, arr] of byDevice) {
    arr.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < arr.length; i++) {
      const delta = (arr[i].counter - arr[i - 1].counter) & 0xFFFF;
      if (delta >= 1 && delta < MAX_STEP_DELTA) out.push({ deviceId, ts: arr[i].ts, delta });
    }
  }
  return out;
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
    const hr = dropDeleted(m.hrSamplesRange({ fromTs: startTs, toTs: endTs, deviceId: args.deviceId, limit: RAW_CAP }), overlay.deletedHrRanges);
    const hrAny = hr.length ? hr : dropDeleted(m.hrSamplesRange({ fromTs: startTs, toTs: endTs, limit: RAW_CAP }), overlay.deletedHrRanges);
    // stepSample/gravitySample are absent from any mirror ingested before this feature shipped —
    // motion stays null rather than a misleading all-zero reading in that case.
    const hasMotion = m.hasTable("stepSample") || m.hasTable("gravitySample");
    // Same device-lineage split as hr/hrAny above: real mirrors carry a session's SCORED sleepSession
    // row under one deviceId (e.g. "my-whoop-noop") while the RAW motion streams are tagged under a
    // sibling deviceId (e.g. "my-whoop") — confirmed against the live production mirror, where a
    // strict args.deviceId filter here silently reads as "no motion" for every real session instead
    // of falling back to whatever device actually carries the raw stream in this time window.
    const stepsOwn = m.stepSamplesRange({ fromTs: startTs, toTs: endTs, deviceId: args.deviceId, limit: RAW_CAP });
    const stepsAny = stepsOwn.length ? stepsOwn : m.stepSamplesRange({ fromTs: startTs, toTs: endTs, limit: RAW_CAP });
    const gravityOwn = m.gravitySamplesRange({ fromTs: startTs, toTs: endTs, deviceId: args.deviceId, limit: RAW_CAP });
    const gravityAny = gravityOwn.length ? gravityOwn : m.gravitySamplesRange({ fromTs: startTs, toTs: endTs, limit: RAW_CAP });
    const motion = hasMotion ? {
      steps: stepDeltas(stepsAny).reduce((sum, d) => sum + d.delta, 0),
      postureChanges: countPostureChanges(gravityAny),
    } : null;
    return {
      session: { deviceId: row.deviceId, family: sourceFamily(row.deviceId), startTs, endTs, durationMin: Math.round((endTs - startTs) / 60), efficiency: row.efficiency, restingHr: row.restingHr, avgHrv: row.avgHrv, ...(adj ? { edited: true, editId: adj.editId } : {}) },
      stages, ...(stageEdit ? { stagesEdited: true, editId: stageEdit.editId } : {}),
      hrDuringSleep: hrAny.map((s) => ({ ts: s.ts, bpm: s.bpm, deviceId: s.deviceId })),
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
  const m = new Mirror(cfg.mirrorPath);
  try {
    const stepsRaw = m.stepSamplesRange({ fromTs, toTs: toT, deviceId: args.deviceId, limit: 200_000 });
    const deltas = stepDeltas(stepsRaw);
    const gravity = m.gravitySamplesRange({ fromTs, toTs: toT, deviceId: args.deviceId, limit: 200_000 });
    type Cell = { ts: number; deviceId: string; steps: number; n: number; gx: number[]; gy: number[]; gz: number[] };
    const byBucket = new Map<string, Cell>();
    const cellFor = (deviceId: string, ts: number) => {
      const bucketTs = Math.floor(ts / b) * b;
      const key = `${deviceId}|${bucketTs}`;
      let c = byBucket.get(key);
      if (!c) { c = { ts: bucketTs, deviceId, steps: 0, n: 0, gx: [], gy: [], gz: [] }; byBucket.set(key, c); }
      return c;
    };
    // Every raw stepSample row is motion evidence (bucket presence + n), even when its own delta
    // isn't computable (first sample per device); the wrap-aware deltas separately add to `steps`.
    for (const s of stepsRaw) { const c = cellFor(s.deviceId, s.ts); c.n += 1; }
    for (const d of deltas) { const c = cellFor(d.deviceId, d.ts); c.steps += d.delta; }
    for (const g of gravity) { const c = cellFor(g.deviceId, g.ts); c.gx.push(g.x); c.gy.push(g.y); c.gz.push(g.z); c.n += 1; }
    const avg = (xs: number[]) => round3(xs.reduce((a, x) => a + x, 0) / xs.length);
    const spread = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
    const buckets = [...byBucket.values()]
      .sort((a, c) => a.ts - c.ts || a.deviceId.localeCompare(c.deviceId))
      .map((x) => ({
        ts: x.ts, deviceId: x.deviceId, family: sourceFamily(x.deviceId), steps: x.steps,
        ...(x.gx.length ? { postureX: avg(x.gx), postureY: avg(x.gy), postureZ: avg(x.gz), postureVar: round3((spread(x.gx) + spread(x.gy) + spread(x.gz)) / 3) } : {}),
        n: x.n,
      }));
    return { buckets };
  } finally { m.close(); }
}

export function registerGranularTools(server: McpServer, cfg: Config): void {
  server.registerTool("hr_series", {
    title: "Heart-rate series",
    description: "Raw or bucketed heart-rate samples for a time range (max 7 days). Use to inspect what actually happened (e.g. verify sleep/wake from HR). Reflects confirmed HR deletions.",
    inputSchema: { from: z.string(), to: z.string(), deviceId: z.string().optional(), bucketSeconds: z.number().int().min(60).max(3600).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(hrSeries(cfg, a)));

  server.registerTool("sleep_detail", {
    title: "Sleep night detail",
    description: "One night's full evidence: bounds, stage-by-stage hypnogram, in-sleep heart-rate, and motion (step count + wrist-posture changes) during the session. Reflects confirmed stage edits, bound adjustments, and HR deletions.",
    inputSchema: { deviceId: z.string(), startTs: z.number().int() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(sleepDetail(cfg, a)));

  server.registerTool("motion_series", {
    title: "Motion series",
    description: "Movement evidence for a time range: step counts + wrist posture (gravity) per bucket. Use with hr_series to distinguish 'awake in bed' (no steps, unchanged posture) from 'up and about' (steps, posture change).",
    inputSchema: { from: z.string(), to: z.string(), deviceId: z.string().optional(), bucketSeconds: z.number().int().min(60).max(3600).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(motionSeries(cfg, a)));
}
