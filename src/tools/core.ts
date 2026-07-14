import { z } from "zod";
import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { Mirror, Family } from "../mirror.js";
import { latestIngest } from "../ingest.js";
import { listPending, journalSince } from "../staging.js";
import { computeOverlay, pointKeyOf } from "../edits/overlay.js";

// set_baseline_note is append-only in the journal (staging.ts never deletes/rewrites rows), but
// surfacing full history means a stale note sits right next to its own replacement — audit-exposed: a
// fixture-era note stayed visible alongside its oura-api correction. computeOverlay's baselineNotes
// is already in application order (activeEdits is ORDER BY seq), so the last entry per deviceId is the
// current one; this collapses to that, tagging how many earlier notes for the same device it replaced.
// Journal history itself is untouched — this only shapes what dataFreshness returns.
function latestBaselineNotes(notes: { note: string; deviceId: string | null; at: number }[]) {
  const byDevice = new Map<string | null, { note: string; deviceId: string | null; at: number; supersededCount: number }>();
  for (const n of notes) {
    const supersededCount = (byDevice.get(n.deviceId)?.supersededCount ?? -1) + 1;
    byDevice.set(n.deviceId, { note: n.note, deviceId: n.deviceId, at: n.at, supersededCount });
  }
  return [...byDevice.values()].map(({ supersededCount, ...rest }) => (supersededCount > 0 ? { ...rest, supersededCount } : rest));
}

export function dataFreshness(cfg: Config) {
  if (!fs.existsSync(cfg.mirrorPath)) {
    const baselineNotes = latestBaselineNotes(computeOverlay(cfg).baselineNotes);
    const j = journalSince(cfg, 0);
    const journalSeq = j.length ? j[j.length - 1].seq : 0;
    return { mirrorAgeSeconds: null, lastIngestAt: null, latestDataDay: null, sources: [], dailyMetricColumns: [], metricSeriesKeys: [], pendingEdits: listPending(cfg).length, journalSeq, baselineNotes, notIngested: true };
  }
  const m = new Mirror(cfg.mirrorPath);
  try {
    const li = latestIngest(cfg);
    const now = Math.floor(Date.now() / 1000);
    const baselineNotes = latestBaselineNotes(computeOverlay(cfg).baselineNotes);
    const j = journalSince(cfg, 0);
    const journalSeq = j.length ? j[j.length - 1].seq : 0;
    return {
      mirrorAgeSeconds: li ? now - li.receivedAt : null,
      lastIngestAt: li ? new Date(li.receivedAt * 1000).toISOString() : null,
      // The phone's IANA timezone as of the most recent upload (X-Phone-Timezone header). null when the
      // uploading build predates the header or sent a malformed value. Every timestamp in the mirror is
      // epoch-UTC, so this is the anchor for any wall-clock reading of the latest data.
      phoneTz: li?.phoneTz ?? null,
      latestDataDay: m.latestDataDay(),
      sources: m.sources().map((s) => ({ deviceId: s.deviceId, family: s.family, latestDay: s.latestDay, tables: s.tables })),
      // Discoverability (post-hoc audit: a whole agent-run was wasted failing to find
      // skinTempDevC because nothing listed valid names). Introspected/aggregated fresh on every
      // call rather than hardcoded, so a phone-side schema change surfaces automatically.
      dailyMetricColumns: m.dailyMetricColumns(),
      metricSeriesKeys: m.metricSeriesKeyCounts(),
      pendingEdits: listPending(cfg).length,
      journalSeq,
      baselineNotes,
    };
  } finally { m.close(); }
}

export function healthSnapshot(cfg: Config, args: { days?: number }) {
  if (!fs.existsSync(cfg.mirrorPath)) {
    return { days: [], notIngested: true };
  }
  const days = Math.max(1, Math.min(args.days ?? 3, 31));
  const overlay = computeOverlay(cfg);
  const m = new Mirror(cfg.mirrorPath);
  try {
    const latest = m.latestDataDay();
    if (!latest) return { days: [] as any[] };
    const to = latest;
    const from = new Date(new Date(`${to}T00:00:00Z`).getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = m.dailyMetrics({ from, to });
    const byDay = new Map<string, any>();
    // A family (e.g. "whoop") can have MULTIPLE deviceIds contributing on the same day
    // (e.g. a strap device + a derived "-noop" lineage). Merge field-wise, preferring the
    // first non-null value in (day, deviceId) order, so no lineage's real data is erased
    // by another lineage's nulls. `sources` records every deviceId that contributed.
    const FIELDS = ["restingHr", "avgHrv", "totalSleepMin", "efficiency", "recovery", "strain", "steps"] as const;
    for (const r of rows) {
      const d = byDay.get(r.day) ?? { day: r.day };
      const fam: Family = r.family;
      const cell = d[fam] ?? { sources: [] as string[] };
      for (const f of FIELDS) {
        if (cell[f] === undefined || cell[f] === null) {
          // A dailyMetric column deleted via delete_metric_point must not surface here even
          // though the raw row still carries it — same overlay compare_sources applies
          // (src/tools/compare.ts).
          if (!overlay.deletedMetricPoints.has(pointKeyOf(r.deviceId, r.day, f))) cell[f] = (r as any)[f];
        }
      }
      cell.sources.push(r.deviceId);
      d[fam] = cell;
      byDay.set(r.day, d);
    }
    return { from, to, days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)) };
  } finally { m.close(); }
}

const asTool = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> });

export function registerCoreTools(server: McpServer, cfg: Config): void {
  server.registerTool("data_freshness", {
    title: "Data freshness",
    description: "How stale the mirror is and which sources it holds (deviceIds that only ever write raw samples, e.g. hrSample-only straps, are included via `tables`), plus discoverable `dailyMetricColumns` and `metricSeriesKeys` (per-family counts) for building compare_sources/metric_series calls. Call this first.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => asTool(dataFreshness(cfg)));

  server.registerTool("health_snapshot", {
    title: "Health snapshot",
    description: "Recent per-day roll-up (recovery, strain, sleep, resting HR, HRV) grouped by source family. Aggregates the phone's own daily rollups — confirmed edits appear here only after Phase-3 phone sync re-uploads.",
    inputSchema: { days: z.number().int().min(1).max(31).optional().describe("How many recent days (default 3).") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => asTool(healthSnapshot(cfg, args)));
}
