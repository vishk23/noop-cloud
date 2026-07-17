import { z } from "zod";
import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { Mirror } from "../mirror.js";
import { computeOverlay, pointKeyOf } from "../edits/overlay.js";

const urlFor = (day: string) => `noop-cloud://day/${day}`;

export function search(cfg: Config, args: { query: string }) {
  if (!fs.existsSync(cfg.mirrorPath)) {
    return { results: [], notIngested: true };
  }
  const m = new Mirror(cfg.mirrorPath);
  try {
    const to = m.latestDataDay(); if (!to) return { results: [] };
    const from = new Date(new Date(`${to}T00:00:00Z`).getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
    const daysSet = new Set(m.dailyMetrics({ from, to }).map((r) => r.day));
    let days = [...daysSet].sort().reverse();
    const m2 = /\d{4}-\d{2}-\d{2}/.exec(args.query);
    if (m2) days = days.filter((d) => d === m2[0]);
    return { results: days.slice(0, 20).map((d) => ({ id: `day:${d}`, title: `Biometrics for ${d}`, url: urlFor(d) })) };
  } finally { m.close(); }
}

export function fetch(cfg: Config, args: { id: string }) {
  if (!fs.existsSync(cfg.mirrorPath)) {
    return { id: args.id, title: "No data", text: "No data ingested yet.", url: "noop-cloud://empty", metadata: { notIngested: true } };
  }
  const day = args.id.replace(/^day:/, "");
  const overlay = computeOverlay(cfg);
  const m = new Mirror(cfg.mirrorPath);
  try {
    const rows = m.dailyMetrics({ from: day, to: day });
    // A dailyMetric column deleted via delete_metric_point must not leak through this ChatGPT
    // Deep Research digest either — same overlay compare_sources/health_snapshot apply.
    const col = (r: (typeof rows)[number], field: string) =>
      overlay.deletedMetricPoints.has(pointKeyOf(r.deviceId, r.day, field)) ? null : (r as any)[field];
    const lines = rows.map((r) => `${r.family}: resting HR ${col(r, "restingHr") ?? "—"}, HRV ${col(r, "avgHrv") ?? "—"}, sleep ${col(r, "totalSleepMin") ?? "—"} min, recovery ${col(r, "recovery") ?? "—"}, strain ${col(r, "strain") ?? "—"}, steps ${col(r, "steps") ?? "—"}`);
    const text = rows.length ? `Biometrics for ${day}\n${lines.join("\n")}` : `No data for ${day}.`;
    return { id: args.id, title: `Biometrics for ${day}`, text, url: urlFor(day), metadata: { day, sources: rows.map((r) => r.family) } };
  } finally { m.close(); }
}

export function registerSearchFetch(server: McpServer, cfg: Config): void {
  server.registerTool("search", {
    title: "Search",
    description: "ChatGPT Deep Research search: find day-records. Returns {id,title,url}. Use a YYYY-MM-DD in the query to target a day. Aggregates the phone's own daily rollups — confirmed edits appear here only after Phase-3 phone sync re-uploads.",
    inputSchema: { query: z.string() },
    // The ChatGPT Deep Research contract shape. Loose: `results` is the only guaranteed key (the
    // no-data path adds notIngested, which a non-strict object simply ignores).
    outputSchema: { results: z.array(z.object({ id: z.string(), title: z.string(), url: z.string() })) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => { const r = search(cfg, a); return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; });

  server.registerTool("fetch", {
    title: "Fetch",
    description: "ChatGPT Deep Research fetch: full text of a record by id (e.g. day:2026-06-13). Aggregates the phone's own daily rollups — confirmed edits appear here only after Phase-3 phone sync re-uploads.",
    inputSchema: { id: z.string() },
    // ChatGPT Deep Research fetch contract. metadata is a free-form object (varies by record), so it
    // passes through unconstrained.
    outputSchema: {
      id: z.string(), title: z.string(), text: z.string(), url: z.string(),
      metadata: z.object({}).passthrough().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => { const r = fetch(cfg, a); return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; });
}
