import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { Mirror, DailyMetricRow } from "../mirror.js";

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const DEFAULT_METRICS = ["restingHr", "avgHrv", "totalSleepMin"] as const;
const asTool = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> });

export function compareSources(cfg: Config, args: { from: string; to: string; metrics?: string[] }) {
  // Guard: if mirror does not exist, return notIngested flag
  if (!fs.existsSync(cfg.mirrorPath)) {
    return { from: args.from, to: args.to, days: [], notIngested: true };
  }

  const metrics = (args.metrics && args.metrics.length ? args.metrics : [...DEFAULT_METRICS]);
  const m = new Mirror(cfg.mirrorPath);
  try {
    const rows = m.dailyMetrics({ from: args.from, to: args.to });
    const byDay = new Map<string, DailyMetricRow[]>();
    for (const r of rows) { const a = byDay.get(r.day) ?? []; a.push(r); byDay.set(r.day, a); }
    const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, drows]) => {
      const metricsOut: Record<string, any> = {};
      for (const metric of metrics) {
        const cell: Record<string, number> = {};
        for (const r of drows) { const v = (r as any)[metric]; if (v !== null && v !== undefined) cell[r.family] = v; }
        const vals = Object.values(cell);
        const spreadPct = vals.length >= 2 ? Math.round(((Math.max(...vals) - Math.min(...vals)) / (vals.reduce((s, x) => s + x, 0) / vals.length)) * 1000) / 10 : 0;
        metricsOut[metric] = { ...cell, spreadPct };
      }
      return { day, metrics: metricsOut };
    });
    return { from: args.from, to: args.to, days };
  } finally { m.close(); }
}

export function registerCompareSources(server: McpServer, cfg: Config): void {
  server.registerTool("compare_sources", {
    title: "Compare sources",
    description: "Per-day WHOOP vs Oura vs Apple side by side for chosen metrics, with a spread %. The corroboration workhorse.",
    inputSchema: { from: DAY, to: DAY, metrics: z.array(z.string()).optional().describe("dailyMetric columns, e.g. restingHr, avgHrv, totalSleepMin, steps.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(compareSources(cfg, a)));
}
