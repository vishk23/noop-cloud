import type { Config } from "../config.js";
import { activeEdits } from "../staging.js";

export const workoutKeyOf = (deviceId: string, startTs: number, sport: string) => `${deviceId}|${startTs}|${sport}`;
export const sleepKeyOf = (deviceId: string, startTs: number) => `${deviceId}|${startTs}`;
export const pointKeyOf = (deviceId: string, day: string, key: string) => `${deviceId}|${day}|${key}`;

/** A dated life event, materialized from the journal (see docs/ANNOTATIONS_DESIGN.md). `seq` is the
 *  journal sequence, carried so a surfaced annotation can be undone via undo_edit without a lookup. */
export interface Annotation {
  editId: string; seq: number; at: number;
  day: string; endDay: string | null;
  startTs: number | null; endTs: number | null;
  tags: string[]; detail: string;
  source: "user_reported" | "agent_inferred";
  tz: string | null;
  values: Record<string, string | number | boolean> | null;
  rationale: string | null;
}

export interface Overlay {
  sleepBounds: Map<string, { newStartTs?: number; newEndTs?: number; editId: string }>;
  deletedWorkouts: Set<string>;
  patchedWorkouts: Map<string, { patch: any; editId: string }>;
  addedWorkouts: { editId: string; deviceId: "noop-cloud"; startTs: number; endTs: number; sport: string; energyKcal: number | null; distanceM: number | null; notes: string | null }[];
  deletedMetricPoints: Set<string>;
  baselineNotes: { note: string; deviceId: string | null; at: number }[];
  stageEdits: Map<string, { stages: { start: number; end: number; stage: string }[]; editId: string }>;
  deletedHrRanges: { deviceId: string; fromTs: number; toTs: number; editId: string }[];
  /** Append-only, unlike baselineNotes: every annotation stays visible. Undoing one drops it here,
   *  because activeEdits already excludes undone rows. */
  annotations: Annotation[];
}

export function computeOverlay(cfg: Pick<Config, "serverDbPath">): Overlay {
  const o: Overlay = { sleepBounds: new Map(), deletedWorkouts: new Set(), patchedWorkouts: new Map(), addedWorkouts: [], deletedMetricPoints: new Set(), baselineNotes: [], stageEdits: new Map(), deletedHrRanges: [], annotations: [] };
  for (const e of activeEdits(cfg)) {
    const p = JSON.parse(e.payloadJSON);
    switch (e.kind) {
      case "delete_workout": o.deletedWorkouts.add(workoutKeyOf(p.deviceId, p.startTs, p.sport)); break;
      case "fix_workout": {
        const k = workoutKeyOf(p.deviceId, p.startTs, p.sport);
        const prev = o.patchedWorkouts.get(k)?.patch ?? {};
        o.patchedWorkouts.set(k, { patch: { ...prev, ...p.patch }, editId: e.editId });
        break;
      }
      case "add_workout":
        o.addedWorkouts.push({ editId: e.editId, deviceId: "noop-cloud", startTs: p.startTs, endTs: p.endTs, sport: p.sport, energyKcal: p.energyKcal ?? null, distanceM: p.distanceM ?? null, notes: p.notes ?? null });
        break;
      case "adjust_sleep_bounds": {
        const k = sleepKeyOf(p.deviceId, p.startTs);
        const prev = o.sleepBounds.get(k) ?? { editId: e.editId };
        o.sleepBounds.set(k, { ...prev, ...(p.newStartTs !== undefined ? { newStartTs: p.newStartTs } : {}), ...(p.newEndTs !== undefined ? { newEndTs: p.newEndTs } : {}), editId: e.editId });
        break;
      }
      case "delete_metric_point": o.deletedMetricPoints.add(pointKeyOf(p.deviceId, p.day, p.key)); break;
      case "set_baseline_note": o.baselineNotes.push({ note: p.note, deviceId: p.deviceId ?? null, at: e.appliedAt }); break;
      case "edit_sleep_stages": o.stageEdits.set(sleepKeyOf(p.deviceId, p.startTs), { stages: p.stages, editId: e.editId }); break;
      case "delete_hr_range": o.deletedHrRanges.push({ deviceId: p.deviceId, fromTs: p.fromTs, toTs: p.toTs, editId: e.editId }); break;
      case "add_annotation":
        o.annotations.push({
          editId: e.editId, seq: e.seq, at: e.appliedAt,
          day: p.day, endDay: p.endDay ?? null,
          startTs: p.startTs ?? null, endTs: p.endTs ?? null,
          tags: p.tags, detail: p.detail, source: p.source,
          tz: p.tz ?? null, values: p.values ?? null, rationale: e.rationale,
        });
        break;
    }
  }
  return o;
}
