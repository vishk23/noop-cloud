import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { Mirror, Family } from "../mirror.js";
import { latestIngest } from "../ingest.js";

export function dataFreshness(cfg: Config) {
  const m = new Mirror(cfg.mirrorPath);
  try {
    const li = latestIngest(cfg);
    const now = Math.floor(Date.now() / 1000);
    return {
      mirrorAgeSeconds: li ? now - li.receivedAt : null,
      lastIngestAt: li ? new Date(li.receivedAt * 1000).toISOString() : null,
      latestDataDay: m.latestDataDay(),
      sources: m.sources().map((s) => ({ deviceId: s.deviceId, family: s.family, latestDay: s.latestDay })),
    };
  } finally { m.close(); }
}

export function healthSnapshot(cfg: Config, args: { days?: number }) {
  const days = Math.max(1, Math.min(args.days ?? 3, 31));
  const m = new Mirror(cfg.mirrorPath);
  try {
    const latest = m.latestDataDay();
    if (!latest) return { days: [] as any[] };
    const to = latest;
    const from = new Date(new Date(`${to}T00:00:00Z`).getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = m.dailyMetrics({ from, to });
    const byDay = new Map<string, any>();
    for (const r of rows) {
      const d = byDay.get(r.day) ?? { day: r.day };
      const fam: Family = r.family;
      d[fam] = { restingHr: r.restingHr, avgHrv: r.avgHrv, totalSleepMin: r.totalSleepMin, efficiency: r.efficiency, recovery: r.recovery, strain: r.strain, steps: r.steps };
      byDay.set(r.day, d);
    }
    return { from, to, days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)) };
  } finally { m.close(); }
}

const asTool = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> });

export function registerCoreTools(server: McpServer, cfg: Config): void {
  server.registerTool("data_freshness", {
    title: "Data freshness",
    description: "How stale the mirror is and which sources it holds. Call this first.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => asTool(dataFreshness(cfg)));

  server.registerTool("health_snapshot", {
    title: "Health snapshot",
    description: "Recent per-day roll-up (recovery, strain, sleep, resting HR, HRV) grouped by source family.",
    inputSchema: { days: z.number().int().min(1).max(31).optional().describe("How many recent days (default 3).") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => asTool(healthSnapshot(cfg, args)));
}
