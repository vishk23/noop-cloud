import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { Mirror } from "../mirror.js";
import { computeOverlay, workoutKeyOf, sleepKeyOf, pointKeyOf } from "../edits/overlay.js";

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const range = { from: DAY, to: DAY };
const asTool = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> });

export function metricSeries(cfg: Config, args: { from: string; to: string; deviceId?: string; key?: string }) {
  if (!fs.existsSync(cfg.mirrorPath)) return { points: [], notIngested: true };
  const overlay = computeOverlay(cfg);
  const m = new Mirror(cfg.mirrorPath);
  try { return { points: m.metricSeries(args).filter((p) => !overlay.deletedMetricPoints.has(pointKeyOf(p.deviceId, p.day, p.key))) }; }
  finally { m.close(); }
}
// Local calendar day ("YYYY-MM-DD") that an epoch-second instant falls on, rendered IN a given IANA
// timezone. Used to match a sleep session to the phoneTimezone table's local-day keys.
function localDayInTz(ts: number, tzId: string): string | null {
  try {
    // en-CA formats as YYYY-MM-DD; timeZone applies the IANA offset (incl. DST).
    return new Intl.DateTimeFormat("en-CA", { timeZone: tzId, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts * 1000));
  } catch { return null; } // invalid/unknown tz id in the mirror → skip, never throw
}

// Resolve the phone timezone a session's START instant was lived under. The phoneTimezone table is
// keyed by LOCAL day, so the UTC day of startTs can be off by one from the local day (e.g. a Pacific
// evening bedtime is already the next UTC day). Try the candidate days within ±1 of the UTC day and
// pick the tz whose own rendering of startTs lands back on that same day — self-consistent, so a
// traveller who changed zones mid-range still gets the right night's zone. Returns null when no stored
// day matches (older mirror with no table, or a night the phone never stamped).
function tzForStart(startTs: number, tzByDay: Map<string, string>): string | null {
  if (tzByDay.size === 0) return null;
  const utcDay = new Date(startTs * 1000).toISOString().slice(0, 10);
  for (const offset of [0, -1, 1]) {
    const cand = new Date((startTs + offset * 86_400) * 1000).toISOString().slice(0, 10);
    const tz = tzByDay.get(cand);
    if (tz && localDayInTz(startTs, tz) === cand) return tz;
  }
  // Fallback: if the exact UTC day is stored, use it even without a self-consistency match.
  return tzByDay.get(utcDay) ?? null;
}

export function sleepSummary(cfg: Config, args: { from: string; to: string }) {
  if (!fs.existsSync(cfg.mirrorPath)) return { sessions: [], notIngested: true };
  const overlay = computeOverlay(cfg);
  const m = new Mirror(cfg.mirrorPath);
  try {
    const tzByDay = m.phoneTimezones(); // empty map on mirrors predating the v28 phoneTimezone table
    const sessions = m.sleepSummary(args).map((s) => {
      const adj = overlay.sleepBounds.get(sleepKeyOf(s.deviceId, s.startTs));
      const startTs = adj?.newStartTs ?? s.startTs;
      const endTs = adj?.newEndTs ?? s.endTs;
      const tzId = tzForStart(startTs, tzByDay);
      return { ...s, startTs, endTs, startIso: new Date(startTs * 1000).toISOString(), durationMin: Math.round((endTs - startTs) / 60), ...(tzId ? { tzId } : {}), ...(adj ? { edited: true, editId: adj.editId } : {}) };
    });
    return { sessions };
  } finally { m.close(); }
}
export function workoutSummary(cfg: Config, args: { from: string; to: string }) {
  if (!fs.existsSync(cfg.mirrorPath)) return { workouts: [], notIngested: true };
  const overlay = computeOverlay(cfg);
  const lo = Math.floor(new Date(`${args.from}T00:00:00Z`).getTime() / 1000);
  const hi = Math.floor(new Date(`${args.to}T23:59:59Z`).getTime() / 1000);
  const m = new Mirror(cfg.mirrorPath);
  try {
    const base = m.workoutSummary(args)
      .filter((w) => !overlay.deletedWorkouts.has(workoutKeyOf(w.deviceId, w.startTs, w.sport)))
      .map((w) => {
        const patch = overlay.patchedWorkouts.get(workoutKeyOf(w.deviceId, w.startTs, w.sport));
        const merged = patch ? { ...w, ...patch.patch, edited: true, editId: patch.editId } : w;
        const patchedTimes = patch && (patch.patch.startTs !== undefined || patch.patch.endTs !== undefined);
        const durationS = patchedTimes ? (merged as any).endTs - merged.startTs : merged.durationS;
        return { ...merged, durationS, startIso: new Date(merged.startTs * 1000).toISOString(), durationMin: durationS != null ? Math.round(durationS / 60) : null };
      });
    const added = overlay.addedWorkouts
      .filter((w) => w.startTs >= lo && w.startTs <= hi)
      .map((w) => ({ deviceId: w.deviceId, family: "cloud" as any, startTs: w.startTs, endTs: w.endTs, sport: w.sport, source: "noop-cloud", durationS: w.endTs - w.startTs, energyKcal: w.energyKcal, distanceM: w.distanceM, startIso: new Date(w.startTs * 1000).toISOString(), durationMin: Math.round((w.endTs - w.startTs) / 60), added: true, editId: w.editId }));
    return { workouts: [...base, ...added].sort((a, b) => a.startTs - b.startTs) };
  } finally { m.close(); }
}

export function registerQueryTools(server: McpServer, cfg: Config): void {
  server.registerTool("metric_series", {
    title: "Metric series",
    description: "Long-format metric points for a date range. Any source (incl. oura-api) and key (e.g. ref_sleep_score, oura_readiness, body_age, fitness_age, sleep_performance, steps_est, vitality, or other oura_*/ref_* scores). Reflects confirmed server-side edits; dailyMetric-derived numbers update only after Phase-3 phone sync. Call data_freshness for the full metricSeriesKeys list (per-family counts) and dailyMetricColumns (the columns compare_sources/health_snapshot read directly).",
    inputSchema: { ...range, deviceId: z.string().optional(), key: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(metricSeries(cfg, a)));

  server.registerTool("sleep_summary", {
    title: "Sleep summary",
    description: "Sleep sessions in a date range with duration and efficiency, per source family. Reflects confirmed server-side edits; dailyMetric-derived numbers update only after Phase-3 phone sync.",
    inputSchema: { ...range },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(sleepSummary(cfg, a)));

  server.registerTool("workout_summary", {
    title: "Workout summary",
    description: "Workouts in a date range (sport, duration, energy, distance), per source family. Reflects confirmed server-side edits; dailyMetric-derived numbers update only after Phase-3 phone sync.",
    inputSchema: { ...range },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(workoutSummary(cfg, a)));
}
