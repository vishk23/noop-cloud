import { z } from "zod";
import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { Mirror, Family } from "../mirror.js";
import { latestIngest } from "../ingest.js";
import { listPending, journalSince } from "../staging.js";
import { computeOverlay, pointKeyOf } from "../edits/overlay.js";
import { annotationsOnDay } from "../edits/annotations.js";
import { annotationSummary } from "./annotations.js";
import { readStatus as readLitersStatus } from "../liters/state.js";
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
  // Deliberately a SUMMARY, not the annotations themselves: its only job is to tell an agent that
  // dated context exists and which tags are in it, so the "call this first" tool advertises the
  // store. The annotations themselves come from the `annotations` tool, or ride along on the
  // sleep/day rows they bear on.
  let annotations: ReturnType<typeof annotationSummary> = { count: 0, tagsInUse: [] };
  let journalSeq = 0, pendingEdits = 0;
  let serverDbError: string | undefined;
  try {
    const overlay = computeOverlay(cfg);
    baselineNotes = latestBaselineNotes(overlay.baselineNotes);
    annotations = annotationSummary(overlay.annotations);
    const j = journalSince(cfg, 0);
    journalSeq = j.length ? j[j.length - 1].seq : 0;
    pendingEdits = listPending(cfg).length;
  } catch (e) {
    if (!isStorageError(e)) throw e;
    serverDbError = e instanceof Error ? e.message : String(e);
  }

  // Taken from the storage report rather than hardcoded null: the mirror's mtime comes from stat(2),
  // which keeps working when the DATABASE cannot be opened at all. A degraded server should still be
  // able to say when its mirror was last written — that is the whole question this tool is called
  // first to answer, and it is answerable in exactly the situation the shell exists for. Both are
  // null when there is genuinely no mirror.
  const shell = {
    mirrorAgeSeconds: storage.mirrorAgeSeconds, mirrorUpdatedAt: storage.mirrorUpdatedAt,
    lastIngestAt: null, lastReplicationAt: null,
    lastWriteSource: null, latestSampleAt: null, dataAgeSeconds: null, latestDataDay: null,
    sources: [] as any[], dailyMetricColumns: [] as string[], metricSeriesKeys: [] as any[],
    pendingEdits, journalSeq, baselineNotes, annotations, storage,
    ...(serverDbError ? { serverDbError } : {}),
  };

  if (!fs.existsSync(cfg.mirrorPath)) return { ...shell, notIngested: true };

  let m: Mirror | undefined;
  try {
    m = new Mirror(cfg.mirrorPath);
    const li = latestIngest(cfg);
    const sources = m.sources();
    // Newest raw sample in the mirror, in seconds. The mtime says the FILE was written; this says
    // DATA arrived, and only the second one justifies "the answer describes old data". Free: it
    // comes off the same GROUP BYs `sources()` already runs, so nothing new is scanned.
    //
    // Scope is exactly the timestamp-keyed tables sources() aggregates — hrSample, rrInterval,
    // sleepSession, appleStepHour. A mirror whose only new rows are ppgHrSample (the v26 optical
    // estimate) therefore reads slightly older here than it truly is; `mirrorUpdatedAt` is the
    // unconditional signal, and this is the corroborating one.
    const latestTs = sources.reduce<number | null>((a, s) => (s.latestTs != null && (a === null || s.latestTs > a) ? s.latestTs : a), null);
    const nowMs = Date.now();
    // Each writer's own stamp, used ONLY to name the writer. `lastIngestAt` is the ingestLog row;
    // `lastReplicationAt` is `lastSyncAtMs` out of the status file the Rust sink republishes after
    // every apply round (src/liters/state.ts) — the sink's own account of when it last wrote.
    // Deliberately not load-bearing: `mirrorAgeSeconds` above is the mtime and stays right even when
    // both of these are missing, which is the whole point of deriving freshness from ground truth.
    const litersSyncMs = cfg.liters?.enabled ? (readLitersStatus(cfg)?.lastSyncAtMs || null) : null;
    const ingestMs = li ? li.receivedAt * 1000 : null;
    // The MTIME arbitrates which path wrote last — not the two stamps above.
    //
    // `/ingest` renames the mirror and appends its ingestLog row microseconds later, so its stamp is
    // never meaningfully older than the mtime it produced. A mirror newer than that stamp was
    // therefore written by something that is not `/ingest`. The tolerance absorbs that ordering gap
    // and the whole-second truncation of `receivedAt`.
    //
    // Deriving this from `lastSyncAtMs` alone was wrong, and production said so a minute after this
    // change deployed: the sink republishes `lastSyncAtMs: 0` until its first apply of the process,
    // so a sidecar restart made a mirror the applier had written 5.9 h earlier report "ingest"
    // against a 2.1-day-old upload. Same lesson as the bug this commit fixes, one level up — a
    // marker that resets is not evidence, and the mtime is.
    const mirrorMs = storage.mirrorUpdatedAt ? Date.parse(storage.mirrorUpdatedAt) : null;
    const notWrittenByIngest = mirrorMs !== null && (ingestMs === null || mirrorMs > ingestMs + 60_000);
    return {
      storage,
      // From the mirror's own mtime (storageReport), NOT from `ingestLog`. The mirror has two
      // writers — `POST /ingest` and the liters applier — and only the first appends an ingestLog
      // row, so the old derivation reported the age of the last WHOLE-DB upload under the name
      // "mirrorAge". Once replication went live in production that read 30.8 h stale against a
      // mirror written 40 seconds earlier, and this is the tool whose >36 h branch tells the agent
      // to warn that the answer describes old data. See StorageReport.mirrorAgeSeconds.
      mirrorAgeSeconds: storage.mirrorAgeSeconds,
      mirrorUpdatedAt: storage.mirrorUpdatedAt,
      // Kept, and now unambiguous: the last time the phone sent the ENTIRE database. Under page
      // replication this is legitimately days older than `mirrorUpdatedAt` on a perfectly healthy
      // server — the gap between them is the replication story, not a fault.
      lastIngestAt: ingestMs ? new Date(ingestMs).toISOString() : null,
      lastReplicationAt: litersSyncMs ? new Date(litersSyncMs).toISOString() : null,
      // Which path last wrote the mirror — the line whose absence made the production report look
      // self-contradictory rather than merely two-sided. "unknown" rather than a guess when the
      // mirror demonstrably moved without `/ingest` on a server where replication is switched OFF:
      // something wrote it and this server cannot say what, which is worth reporting as such.
      lastWriteSource: (litersSyncMs ?? 0) > (ingestMs ?? 0) || notWrittenByIngest
        ? (cfg.liters?.enabled ? "replication" : "unknown")
        : (ingestMs ? "ingest" : null),
      latestSampleAt: latestTs != null ? new Date(latestTs * 1000).toISOString() : null,
      dataAgeSeconds: latestTs != null ? Math.max(0, Math.floor(nowMs / 1000 - latestTs)) : null,
      // The phone's IANA timezone as of the most recent upload (X-Phone-Timezone header). null when the
      // uploading build predates the header or sent a malformed value. Every timestamp in the mirror is
      // epoch-UTC, so this is the anchor for any wall-clock reading of the latest data.
      phoneTz: li?.phoneTz ?? null,
      latestDataDay: m.latestDataDay(),
      sources: sources.map((s) => ({ deviceId: s.deviceId, family: s.family, latestDay: s.latestDay, tables: s.tables })),
      // Discoverability (post-hoc audit: a whole agent-run was wasted failing to find
      // skinTempDevC because nothing listed valid names). Introspected/aggregated fresh on every
      // call rather than hardcoded, so a phone-side schema change surfaces automatically.
      dailyMetricColumns: m.dailyMetricColumns(),
      metricSeriesKeys: m.metricSeriesKeyCounts(),
      pendingEdits,
      journalSeq,
      baselineNotes,
      annotations,
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

    // metricSeries fallback — the SAME one compare_sources applies (src/tools/compare.ts), and it is
    // here because the two tools were answering the same question differently.
    //
    // The phone's Apple Health import routes steps to metricSeries + appleDaily, and writes a
    // dailyMetric row carrying only (deviceId, day) — every metric column NULL. Reading dailyMetric
    // alone therefore produced an `apple` cell that looked present and measured nothing: on
    // 2026-07-30 compare_sources reported apple steps of 8623 / 6751 / 896 for three consecutive
    // days while health_snapshot reported `steps: null` for all three, off one mirror. The empty
    // rows are also why the family shows up at all — `sources: ["apple-health"]` came from a row
    // with no data in it.
    //
    // dailyMetric still WINS wherever it has a value; this only fills cells that are still null, so
    // no existing answer changes. Family-scoped like compare's, and it honours the same
    // delete_metric_point overlay, so a deleted point cannot reappear through the fallback.
    const seriesRows = m.metricSeriesForKeys({ keys: [...FIELDS], from, to });
    for (const r of seriesRows) {
      if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day });
      const d = byDay.get(r.day);
      const cell = d[r.family as Family] ?? { sources: [] as string[] };
      const f = r.key as (typeof FIELDS)[number];
      if (cell[f] === undefined || cell[f] === null) {
        if (!overlay.deletedMetricPoints.has(pointKeyOf(r.deviceId, r.day, r.key))) cell[f] = r.value;
      }
      if (!cell.sources.includes(r.deviceId)) cell.sources.push(r.deviceId);
      d[r.family as Family] = cell;
    }

    // Dated context per day (its own annotations + any span covering it), attached after the
    // field-wise merge so it is never confused with a source family's cell.
    const withAnnotations = [...byDay.values()].map((d) => {
      const anns = annotationsOnDay(overlay.annotations, d.day);
      return anns.length ? { ...d, annotations: anns } : d;
    });
    return { from, to, days: withAnnotations.sort((a, b) => a.day.localeCompare(b.day)) };
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
  appleStepHour: "motion_series",
  // appleDaily IS read by health_snapshot / compare_sources, through the metricSeries fallback the
  // Apple Health import's daily rollups land in. It was the only populated table missing from this
  // map while its sibling appleStepHour was listed, so `streams` reported it as reader-less — and
  // because it is not a GAP_CANDIDATE either, it was not even surfaced as a gap. Unreadable by the
  // tool's own contract, and invisible.
  appleDaily: "health_snapshot / compare_sources",
  imuActivity: "imu_series / imu_coverage", battery: "battery_series",
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
    description: "How stale the mirror is and which sources it holds (deviceIds that only ever write raw samples, e.g. hrSample-only straps, are included via `tables`), plus discoverable `dailyMetricColumns` and `metricSeriesKeys` (per-family counts) for building compare_sources/metric_series calls. STALENESS: judge it by `mirrorAgeSeconds`/`mirrorUpdatedAt` (when the mirror was last WRITTEN, by any path) and `dataAgeSeconds`/`latestSampleAt` (the newest raw sample) — NOT by `lastIngestAt`, which means only the last WHOLE-DATABASE upload and is legitimately days older on a healthy server that receives page-replication deltas. `lastWriteSource` names which path wrote last. Also returns `storage` — disk free/total, mirror size, orphaned staging bytes — so server-side degradation is visible here rather than as an opaque failure in some other tool. `degraded: true` means the mirror could not be READ (empty arrays mean unreachable, not absent). Two kinds of context ride along: `baselineNotes` is STANDING context true across a whole era (e.g. a supplement protocol that explains the entire WHOOP baseline — read it before calling anything illness), and `annotations` is a COUNT + tag list pointing at the dated life-event store (alcohol, travel, illness, known artifacts) — call the `annotations` tool for the events themselves. Call this first.",
    inputSchema: {},
    // Loose: only fields present in BOTH the mirror and no-mirror branches, with per-item objects left
    // passthrough so conditional keys (phoneTz, notIngested, per-source latestDay, note supersededCount)
    // never fail validation. Documents the shape without constraining the variable parts.
    outputSchema: {
      mirrorAgeSeconds: z.number().nullable(),
      mirrorUpdatedAt: z.string().nullable(),
      lastIngestAt: z.string().nullable(),
      lastReplicationAt: z.string().nullable().optional(),
      lastWriteSource: z.string().nullable().optional(),
      latestSampleAt: z.string().nullable().optional(),
      dataAgeSeconds: z.number().nullable().optional(),
      phoneTz: z.string().nullable().optional(),
      latestDataDay: z.string().nullable(),
      sources: z.array(z.object({ deviceId: z.string(), family: z.string(), tables: z.array(z.string()) }).passthrough()),
      dailyMetricColumns: z.array(z.string()),
      metricSeriesKeys: z.array(z.object({ key: z.string() }).passthrough()),
      pendingEdits: z.number(),
      journalSeq: z.number(),
      baselineNotes: z.array(z.object({ note: z.string(), deviceId: z.string().nullable(), at: z.number() }).passthrough()),
      // Pointer, not payload — see the `annotations` tool. Passthrough because firstDay/lastDay are
      // absent when the store is empty.
      annotations: z.object({ count: z.number(), tagsInUse: z.array(z.string()) }).passthrough().optional(),
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
    description: "Recent per-day roll-up (recovery, strain, sleep, resting HR, HRV) grouped by source family. Aggregates the phone's own daily rollups — confirmed edits appear here only after Phase-3 phone sync re-uploads. A day with dated context (alcohol, illness, travel, a known measurement artifact) carries it as `annotations` — read those before interpreting that day's numbers.",
    inputSchema: { days: z.number().int().min(1).max(31).optional().describe("How many recent days (default 3).") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => asTool(healthSnapshot(cfg, args)));
}
