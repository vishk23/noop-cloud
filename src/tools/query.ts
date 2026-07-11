import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { Mirror } from "../mirror.js";

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const range = { from: DAY, to: DAY };
const asTool = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> });

export function metricSeries(cfg: Config, args: { from: string; to: string; deviceId?: string; key?: string }) {
  if (!fs.existsSync(cfg.mirrorPath)) return { points: [], notIngested: true };
  const m = new Mirror(cfg.mirrorPath); try { return { points: m.metricSeries(args) }; } finally { m.close(); }
}
export function sleepSummary(cfg: Config, args: { from: string; to: string }) {
  if (!fs.existsSync(cfg.mirrorPath)) return { sessions: [], notIngested: true };
  const m = new Mirror(cfg.mirrorPath);
  try { return { sessions: m.sleepSummary(args).map((s) => ({ ...s, startIso: new Date(s.startTs * 1000).toISOString(), durationMin: Math.round((s.endTs - s.startTs) / 60) })) }; }
  finally { m.close(); }
}
export function workoutSummary(cfg: Config, args: { from: string; to: string }) {
  if (!fs.existsSync(cfg.mirrorPath)) return { workouts: [], notIngested: true };
  const m = new Mirror(cfg.mirrorPath);
  try { return { workouts: m.workoutSummary(args).map((w) => ({ ...w, startIso: new Date(w.startTs * 1000).toISOString(), durationMin: w.durationS ? Math.round(w.durationS / 60) : null })) }; }
  finally { m.close(); }
}

export function registerQueryTools(server: McpServer, cfg: Config): void {
  server.registerTool("metric_series", {
    title: "Metric series",
    description: "Long-format metric points for a date range. Any source (incl. oura-api) and key (e.g. ref_sleep_score, oura_readiness).",
    inputSchema: { ...range, deviceId: z.string().optional(), key: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(metricSeries(cfg, a)));

  server.registerTool("sleep_summary", {
    title: "Sleep summary",
    description: "Sleep sessions in a date range with duration and efficiency, per source family.",
    inputSchema: { ...range },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(sleepSummary(cfg, a)));

  server.registerTool("workout_summary", {
    title: "Workout summary",
    description: "Workouts in a date range (sport, duration, energy, distance), per source family.",
    inputSchema: { ...range },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(workoutSummary(cfg, a)));
}
