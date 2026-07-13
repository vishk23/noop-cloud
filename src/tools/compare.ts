import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { Mirror, DailyMetricRow } from "../mirror.js";
import { computeOverlay, pointKeyOf } from "../edits/overlay.js";

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const DEFAULT_METRICS = ["restingHr", "avgHrv", "totalSleepMin"] as const;
const asTool = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> });

export function compareSources(cfg: Config, args: { from: string; to: string; metrics?: string[] }) {
  // Guard: if mirror does not exist, return notIngested flag
  if (!fs.existsSync(cfg.mirrorPath)) {
    return { from: args.from, to: args.to, days: [], notIngested: true };
  }

  const metrics = (args.metrics && args.metrics.length ? args.metrics : [...DEFAULT_METRICS]);
  const overlay = computeOverlay(cfg);
  const m = new Mirror(cfg.mirrorPath);
  try {
    const rows = m.dailyMetrics({ from: args.from, to: args.to });
    const byDay = new Map<string, DailyMetricRow[]>();
    for (const r of rows) { const a = byDay.get(r.day) ?? []; a.push(r); byDay.set(r.day, a); }
    // Fallback source: some devices route a metric to metricSeries instead of the dailyMetric
    // column (e.g. the phone's Apple Health import writes steps to metricSeries+appleDaily, not
    // dailyMetric). One query for the whole range/metric set, grouped by "day|key" below.
    const seriesRows = m.metricSeriesForKeys({ keys: metrics, from: args.from, to: args.to });
    const seriesByDayKey = new Map<string, typeof seriesRows>();
    for (const r of seriesRows) { const k = `${r.day}|${r.key}`; const a = seriesByDayKey.get(k) ?? []; a.push(r); seriesByDayKey.set(k, a); }
    // Day universe = union of dailyMetric days and metricSeries fallback days. Deriving `days`
    // from byDay alone silently dropped a day whose only evidence was a metricSeries fallback row
    // (e.g. Apple steps on a day no wearable wrote a dailyMetric row at all) — see
    // tools-compare.test.ts's "day universe" tests for the regression this fixes.
    const allDays = new Set<string>(byDay.keys());
    for (const r of seriesRows) allDays.add(r.day);
    const days = [...allDays].sort((a, b) => a.localeCompare(b)).map((day) => {
      const drows = byDay.get(day) ?? [];
      const metricsOut: Record<string, any> = {};
      for (const metric of metrics) {
        // A family can have multiple same-family deviceIds (e.g. WHOOP strap + derived
        // "-noop" lineage). Collect all non-null values per family and use their mean as
        // the family's value, but keep every raw per-device reading visible via `perDevice`
        // so intra-family disagreement isn't silently averaged away.
        const byFamily = new Map<string, number[]>();
        const perDevice: Record<string, number> = {};
        for (const r of drows) {
          const v = (r as any)[metric];
          if (v === null || v === undefined) continue;
          // delete_metric_point can target a dailyMetric column directly (not just a metricSeries
          // key) — a deleted column value must not count toward the family average, and must free
          // the family up for the metricSeries fallback below exactly like a genuinely-null
          // dailyMetric value already does.
          if (overlay.deletedMetricPoints.has(pointKeyOf(r.deviceId, r.day, metric))) continue;
          const arr = byFamily.get(r.family) ?? [];
          arr.push(v);
          byFamily.set(r.family, arr);
          perDevice[r.deviceId] = v;
        }
        // metricSeries fallback: only for families dailyMetric had nothing for (dailyMetric wins
        // when present). Snapshot the dailyMetric-covered families BEFORE merging fallback rows in,
        // so multiple fallback devices in the same (uncovered) family still merge correctly.
        const dailyFamilies = new Set(byFamily.keys());
        for (const r of seriesByDayKey.get(`${day}|${metric}`) ?? []) {
          if (dailyFamilies.has(r.family)) continue;
          if (overlay.deletedMetricPoints.has(pointKeyOf(r.deviceId, r.day, r.key))) continue;
          const arr = byFamily.get(r.family) ?? [];
          arr.push(r.value);
          byFamily.set(r.family, arr);
          perDevice[r.deviceId] = r.value;
        }
        const cell: Record<string, number> = {};
        let multiDevice = false;
        for (const [fam, famVals] of byFamily) {
          cell[fam] = Math.round((famVals.reduce((s, x) => s + x, 0) / famVals.length) * 10) / 10;
          if (famVals.length > 1) multiDevice = true;
        }
        const vals = Object.values(cell);
        const spreadPct = vals.length >= 2 ? Math.round(((Math.max(...vals) - Math.min(...vals)) / (vals.reduce((s, x) => s + x, 0) / vals.length)) * 1000) / 10 : 0;
        metricsOut[metric] = multiDevice ? { ...cell, spreadPct, perDevice } : { ...cell, spreadPct };
      }
      return { day, metrics: metricsOut };
    });
    return { from: args.from, to: args.to, days };
  } finally { m.close(); }
}

export function registerCompareSources(server: McpServer, cfg: Config): void {
  server.registerTool("compare_sources", {
    title: "Compare sources",
    description: "Per-day WHOOP vs Oura vs Apple side by side for chosen metrics, with a spread %. The corroboration workhorse. Aggregates the phone's own daily rollups — confirmed edits appear here only after Phase-3 phone sync re-uploads. Falls back to metricSeries keys (e.g. Apple steps) when a source lacks the dailyMetric column.",
    inputSchema: { from: DAY, to: DAY, metrics: z.array(z.string()).optional().describe("dailyMetric columns (e.g. restingHr, avgHrv, totalSleepMin, steps) or metricSeries keys — falls back to metricSeries per-family when a source has no dailyMetric value.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(compareSources(cfg, a)));
}
