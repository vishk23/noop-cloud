import { z } from "zod";
import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { Mirror, Family } from "../mirror.js";
import { latestIngest } from "../ingest.js";
import { listPending, journalSince } from "../staging.js";
import { computeOverlay, pointKeyOf } from "../edits/overlay.js";
import { storageReport, isStorageError, storageFailureMessage } from "../storage.js";

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

// data_freshness is documented as "Call this first", which makes it the one tool that MUST survive a
// broken volume — during the 2026-07-26 outage it died with the same bare `disk I/O error` as
// everything else, so the diagnostic tool was unavailable exactly when it was needed. Every read
// below is now individually guarded and the storage report is attached unconditionally, so a
// degraded server still answers with WHY it is degraded instead of throwing.
export function dataFreshness(cfg: Config) {
  const storage = storageReport(cfg);

  // The journal/overlay/pending reads all open server.sqlite, which lives on the same volume as the
  // mirror — so they fail for the same reason and need the same guard.
  let baselineNotes: ReturnType<typeof latestBaselineNotes> = [];
  let journalSeq = 0, pendingEdits = 0;
  let serverDbError: string | undefined;
  try {
    baselineNotes = latestBaselineNotes(computeOverlay(cfg).baselineNotes);
    const j = journalSince(cfg, 0);
    journalSeq = j.length ? j[j.length - 1].seq : 0;
    pendingEdits = listPending(cfg).length;
  } catch (e) {
    if (!isStorageError(e)) throw e;
    serverDbError = e instanceof Error ? e.message : String(e);
  }

  const shell = {
    mirrorAgeSeconds: null, lastIngestAt: null, latestDataDay: null,
    sources: [] as any[], dailyMetricColumns: [] as string[], metricSeriesKeys: [] as any[],
    pendingEdits, journalSeq, baselineNotes, storage,
    ...(serverDbError ? { serverDbError } : {}),
  };

  if (!fs.existsSync(cfg.mirrorPath)) return { ...shell, notIngested: true };

  let m: Mirror | undefined;
  try {
    m = new Mirror(cfg.mirrorPath);
    const li = latestIngest(cfg);
    const now = Math.floor(Date.now() / 1000);
    return {
      storage,
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
      pendingEdits,
      journalSeq,
      baselineNotes,
    };
  } catch (e) {
    if (!isStorageError(e)) throw e;
    // The mirror is unreadable but the report itself still lands: `storage` carries the disk numbers,
    // `degraded` tells a caller not to interpret the empty arrays as "no data exists".
    return { ...shell, degraded: true, error: storageFailureMessage(cfg, e) };
  } finally { m?.close(); }
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

// Which MCP tool reads each mirror table — the map that makes `streams` self-describing. Kept here (not
// derived) on purpose: it encodes the intended contract "this stream has a reader", so a populated stream
// that ISN'T in this map surfaces as a gap rather than silently looking covered.
const STREAM_READERS: Record<string, string> = {
  hrSample: "hr_series", rrInterval: "hrv_series", skinTempSample: "temp_series",
  // ppgHrSample IS read by hr_series: the query unions it with the same NOT EXISTS anti-join the phone
  // uses, so a second the strap never reported is filled by the v26 optical estimate and a measured
  // second never is. Listing it here is what stops `streams` telling an agent to ignore live data.
  ppgHrSample: "hr_series",
  sleepStateSample: "sleep_state_series", gravitySample: "motion_series", stepSample: "motion_series",
  appleStepHour: "motion_series", imuActivity: "imu_series / imu_coverage", battery: "battery_series",
  event: "device_events", sleepSession: "sleep_summary / sleep_detail", workout: "workout_summary",
  dailyMetric: "health_snapshot / compare_sources / metric_series", metricSeries: "metric_series",
  // NOTE: `rawBatch` is deliberately absent. It used to be listed as read by deep_buffer_coverage /
  // deep_buffer_window, which is false: both of those SELECT FROM `deepBufferChunk` — a SERVER-side table
  // fed by the /deepbuf JSONL endpoint (see tools/deepbuf.ts), not the phone's `rawBatch` mirror table.
  // The wrong entry also suppressed gap detection for it, since a non-null readBy means "covered".
};
// Per-stream caveats. A note EXPLAINS a stream; it does not suppress it. A populated table with no reader
// still shows up in `gaps` even when annotated — the note tells the agent whether the gap is worth
// closing, which is a different question from whether the gap exists.
const STREAM_NOTES: Record<string, string> = {
  spo2Sample: "not emitted by the WHOOP 5/MG — expect 0 rows",
  respSample: "no per-sample respiratory rate captured — expect 0 rows",
  v18AuxSample: "v18 aux bytes banked verbatim before the strap frees history on offload-ack; the app "
    + "deliberately ships no consumer (WhoopStore Database.swift v31). Capped at 604,800 rows/device on "
    + "device, and ingest REPLACES the mirror wholesale — so anything the phone prunes is gone here too.",
  ppgWaveformSample: "raw v26 optical samples, kept so a future estimator can rerun over originals rather "
    + "than derived bpm; the app deliberately ships no consumer. The DERIVED ppgHrSample is separately "
    + "read by hr_series — these rows sit on no scoring path.",
  ouraRaw: "verbatim Oura API page archive (the re-derivation backstop). Its `day` column is NULL on every "
    + "row: both producers pass day: nil because a page spans many documents and days, so day-keyed reads "
    + "and the ORDER BY day in the on-device reader are inert.",
  scoreInputProvenance: "per-day (day, key, sourceId) attribution for NOOP-computed recovery/strain/"
    + "sleep_performance — i.e. WHICH device's inputs produced each -noop score. Read on device to render "
    + "the source badge; not yet joined into compare_sources / health_snapshot here.",
  appleDaily: "Apple Health per-day rollup. dailyMetric already carries the apple-health family that "
    + "health_snapshot / compare_sources read, so this is a redundant second copy rather than a lost stream.",
};
// Tables that are bookkeeping or registry rather than a captured stream, so "no reader" is the correct
// resting state and never a gap. Everything NOT listed here is a gap candidate by default — the deny-list
// direction matters: an allow-list has to be hand-extended for every new table, which is exactly how this
// check silently degraded to a tautology (the old GAP_CANDIDATES set was a strict subset of
// STREAM_READERS, so `!readBy && GAP_CANDIDATES.has(table)` could never be true for any database).
const NON_STREAM_TABLES = new Set([
  "grdb_migrations", "cursors", "phoneTimezone", "pairedDevice", "device", "dayOwnership", "cloudTombstone",
]);
const isNonStream = (t: string) => NON_STREAM_TABLES.has(t) || t.startsWith("_litestream");

export function streamsInventory(cfg: Config) {
  if (!fs.existsSync(cfg.mirrorPath)) return { streams: [], gaps: [], notIngested: true };
  const m = new Mirror(cfg.mirrorPath);
  try {
    const streams = m.streamInventory().map((s) => {
      const readBy = STREAM_READERS[s.table] ?? null;
      const fmt = (v: number | string | null) => v == null ? null : (s.timeCol === "day" ? v : new Date((v as number) * 1000).toISOString());
      return {
        table: s.table, rows: s.rows, deviceIds: s.deviceIds, readBy,
        ...(STREAM_NOTES[s.table] ? { note: STREAM_NOTES[s.table] } : {}),
        ...(s.timeCol ? { timeCol: s.timeCol, first: fmt(s.first), last: fmt(s.last) } : {}),
      };
    }).sort((a, b) => b.rows - a.rows);
    const gaps = streams.filter((s) => s.rows > 0 && !s.readBy && !isNonStream(s.table)).map((s) => s.table);
    return { streams, gaps, note: gaps.length ? "gaps = populated streams with NO MCP reader — capture that no tool can retrieve. Check each one's `note` before treating it as a build target: some are deliberately-unread instrumentation." : "every populated stream has a reader" };
  } finally { m.close(); }
}

const asTool = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> });

export function registerCoreTools(server: McpServer, cfg: Config): void {
  server.registerTool("data_freshness", {
    title: "Data freshness",
    description: "How stale the mirror is and which sources it holds (deviceIds that only ever write raw samples, e.g. hrSample-only straps, are included via `tables`), plus discoverable `dailyMetricColumns` and `metricSeriesKeys` (per-family counts) for building compare_sources/metric_series calls. Also returns `storage` — disk free/total, mirror size, orphaned staging bytes, and age of the last successful ingest — so server-side degradation is visible here rather than as an opaque failure in some other tool. `degraded: true` means the mirror could not be READ (empty arrays mean unreachable, not absent). Call this first.",
    inputSchema: {},
    // Loose: only fields present in BOTH the mirror and no-mirror branches, with per-item objects left
    // passthrough so conditional keys (phoneTz, notIngested, per-source latestDay, note supersededCount)
    // never fail validation. Documents the shape without constraining the variable parts.
    outputSchema: {
      mirrorAgeSeconds: z.number().nullable(),
      lastIngestAt: z.string().nullable(),
      phoneTz: z.string().nullable().optional(),
      latestDataDay: z.string().nullable(),
      sources: z.array(z.object({ deviceId: z.string(), family: z.string(), tables: z.array(z.string()) }).passthrough()),
      dailyMetricColumns: z.array(z.string()),
      metricSeriesKeys: z.array(z.object({ key: z.string() }).passthrough()),
      pendingEdits: z.number(),
      journalSeq: z.number(),
      baselineNotes: z.array(z.object({ note: z.string(), deviceId: z.string().nullable(), at: z.number() }).passthrough()),
      // Storage/ingest health, always present. `degraded` + `error` appear only when the mirror could
      // not be read, in which case the arrays above are empty because the DATA IS UNREACHABLE, not
      // because it is absent — a distinction nothing surfaced during the 2026-07-26 outage.
      storage: z.object({ ok: z.boolean(), warnings: z.array(z.string()) }).passthrough().optional(),
      degraded: z.boolean().optional(),
      error: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => asTool(dataFreshness(cfg)));

  server.registerTool("streams", {
    title: "Raw stream inventory",
    description: "The self-describing map of the mirror: every raw table with its row count, time span, contributing deviceIds, and — crucially — WHICH MCP tool reads it (`readBy`), so an agent can see what granular data exists and how to get it without inspecting the DB. `gaps` lists populated biometric streams that have NO reader yet (capture-without-a-reader — a candidate for a new tool); an empty `gaps` means every populated stream is reachable. Per-stream `note` flags the deliberate non-gaps (e.g. spo2Sample is 0 rows on the 5/MG). Note `hr_series` reads hrSample UNION ppgHrSample (the v26 optical per-second estimate, admitted only for seconds with no measured row) — the same union the phone applies, so a PPG-heavy stretch is not silently under-reported. Rollups (dailyMetric/metricSeries) and bookkeeping tables are listed but excluded from `gaps`. Call this to answer 'what data do we actually have and can I query it' before guessing.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => asTool(streamsInventory(cfg)));

  server.registerTool("health_snapshot", {
    title: "Health snapshot",
    description: "Recent per-day roll-up (recovery, strain, sleep, resting HR, HRV) grouped by source family. Aggregates the phone's own daily rollups — confirmed edits appear here only after Phase-3 phone sync re-uploads.",
    inputSchema: { days: z.number().int().min(1).max(31).optional().describe("How many recent days (default 3).") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => asTool(healthSnapshot(cfg, args)));
}
