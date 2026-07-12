import type { Config } from "../config.js";
import { activeEdits } from "../staging.js";

export const workoutKeyOf = (deviceId: string, startTs: number, sport: string) => `${deviceId}|${startTs}|${sport}`;
export const sleepKeyOf = (deviceId: string, startTs: number) => `${deviceId}|${startTs}`;
export const pointKeyOf = (deviceId: string, day: string, key: string) => `${deviceId}|${day}|${key}`;

export interface Overlay {
  sleepBounds: Map<string, { newStartTs?: number; newEndTs?: number; editId: string }>;
  deletedWorkouts: Set<string>;
  patchedWorkouts: Map<string, { patch: any; editId: string }>;
  addedWorkouts: { editId: string; deviceId: "noop-cloud"; startTs: number; endTs: number; sport: string; energyKcal: number | null; distanceM: number | null; notes: string | null }[];
  deletedMetricPoints: Set<string>;
  baselineNotes: { note: string; deviceId: string | null; at: number }[];
}

export function computeOverlay(cfg: Pick<Config, "serverDbPath">): Overlay {
  const o: Overlay = { sleepBounds: new Map(), deletedWorkouts: new Set(), patchedWorkouts: new Map(), addedWorkouts: [], deletedMetricPoints: new Set(), baselineNotes: [] };
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
    }
  }
  return o;
}
