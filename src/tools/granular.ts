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

function dropDeleted(samples: { deviceId: string; ts: number; bpm: number }[], ranges: { deviceId: string; fromTs: number; toTs: number }[]) {
  if (!ranges.length) return samples;
  return samples.filter((s) => !ranges.some((r) => r.deviceId === s.deviceId && s.ts >= r.fromTs && s.ts <= r.toTs));
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
    return {
      session: { deviceId: row.deviceId, family: sourceFamily(row.deviceId), startTs, endTs, durationMin: Math.round((endTs - startTs) / 60), efficiency: row.efficiency, restingHr: row.restingHr, avgHrv: row.avgHrv, ...(adj ? { edited: true, editId: adj.editId } : {}) },
      stages, ...(stageEdit ? { stagesEdited: true, editId: stageEdit.editId } : {}),
      hrDuringSleep: hrAny.map((s) => ({ ts: s.ts, bpm: s.bpm, deviceId: s.deviceId })),
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

  server.registerTool("sleep_detail", {
    title: "Sleep night detail",
    description: "One night's full evidence: bounds, stage-by-stage hypnogram, and in-sleep heart-rate. Reflects confirmed stage edits, bound adjustments, and HR deletions.",
    inputSchema: { deviceId: z.string(), startTs: z.number().int() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(sleepDetail(cfg, a)));
}
