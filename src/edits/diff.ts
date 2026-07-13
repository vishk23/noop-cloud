import fs from "node:fs";
import Database from "better-sqlite3";
import type { Config } from "../config.js";
import { isDailyMetricColumnKey, EditKind } from "./kinds.js";

export class EditTargetError extends Error {
  constructor(public code: "target_not_found" | "not_ingested", msg?: string) { super(msg ?? code); }
}

const iso = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z";

/** Merge consecutive same-stage segments and sum minutes: "light 60m/deep 120m/rem 120m/light 120m". */
function stageSummary(stages: { start: number; end: number; stage: string }[] | null | undefined): string {
  if (!stages || !stages.length) return "no stages";
  const merged: { stage: string; minutes: number }[] = [];
  for (const s of stages) {
    const minutes = Math.round((s.end - s.start) / 60);
    const last = merged[merged.length - 1];
    if (last && last.stage === s.stage) last.minutes += minutes;
    else merged.push({ stage: s.stage, minutes });
  }
  return merged.map((m) => `${m.stage} ${m.minutes}m`).join("/");
}

/** Read-only peek at the mirror for the row an edit targets. null for kinds with no target. */
export function captureBefore(cfg: Pick<Config, "mirrorPath">, kind: EditKind, payload: any): object | null {
  if (kind === "add_workout" || kind === "set_baseline_note") return null;
  if (!fs.existsSync(cfg.mirrorPath)) throw new EditTargetError("not_ingested");
  const db = new Database(cfg.mirrorPath, { readonly: true, fileMustExist: true });
  try {
    let row: unknown;
    if (kind === "fix_workout" || kind === "delete_workout") {
      row = db.prepare("SELECT * FROM workout WHERE deviceId=? AND startTs=? AND sport=?").get(payload.deviceId, payload.startTs, payload.sport);
    } else if (kind === "adjust_sleep_bounds" || kind === "edit_sleep_stages") {
      row = db.prepare("SELECT * FROM sleepSession WHERE deviceId=? AND startTs=?").get(payload.deviceId, payload.startTs);
    } else if (kind === "delete_metric_point") {
      // key can now name an allowlisted dailyMetric column (in addition to its original
      // metricSeries-key meaning) — column names win when a key matches one, since that's the
      // confirmed-bogus-data-point use case this branch exists for. See DAILY_METRIC_EDITABLE_COLUMNS.
      if (isDailyMetricColumnKey(payload.key)) {
        const dm = db.prepare("SELECT * FROM dailyMetric WHERE deviceId=? AND day=?").get(payload.deviceId, payload.day) as any;
        const value = dm ? dm[payload.key] : null;
        row = (value === null || value === undefined) ? undefined : { source: "dailyMetric", deviceId: payload.deviceId, day: payload.day, key: payload.key, value };
      } else {
        const seriesRow = db.prepare("SELECT * FROM metricSeries WHERE deviceId=? AND day=? AND key=?").get(payload.deviceId, payload.day, payload.key);
        row = seriesRow ? { source: "metricSeries", ...(seriesRow as object) } : undefined;
      }
    } else if (kind === "delete_hr_range") {
      row = db.prepare("SELECT COUNT(*) AS count FROM hrSample WHERE deviceId=? AND ts>=? AND ts<=?").get(payload.deviceId, payload.fromTs, payload.toTs);
      if ((row as { count: number }).count === 0) throw new EditTargetError("target_not_found", `${kind}: no HR samples in range`);
      return row as object;
    }
    if (!row) throw new EditTargetError("target_not_found", `${kind}: no matching row in the mirror`);
    return row as object;
  } finally { db.close(); }
}

export function renderDiff(kind: EditKind, payload: any, before: any): string {
  switch (kind) {
    case "delete_workout":
      return `DELETE workout ${before.sport} @ ${iso(before.startTs)} (${before.durationS ? Math.round(before.durationS / 60) + " min" : "?"}, source ${before.source ?? "?"}, ${payload.deviceId})`;
    case "fix_workout": {
      const parts = Object.entries(payload.patch).map(([k, v]) => `${k}: ${JSON.stringify((before as any)[k])} ⇒ ${JSON.stringify(v)}`);
      return `FIX workout ${before.sport} @ ${iso(before.startTs)} (${payload.deviceId}): ${parts.join(", ")}`;
    }
    case "add_workout":
      return `ADD workout ${payload.sport} ${iso(payload.startTs)} → ${iso(payload.endTs)} (source noop-cloud${payload.energyKcal ? `, ${payload.energyKcal} kcal` : ""})`;
    case "adjust_sleep_bounds": {
      const bits: string[] = [];
      if (payload.newStartTs !== undefined) bits.push(`start ${iso(before.startTs)} ⇒ ${iso(payload.newStartTs)}`);
      if (payload.newEndTs !== undefined) bits.push(`end ${iso(before.endTs)} ⇒ ${iso(payload.newEndTs)}`);
      return `ADJUST sleep @ ${iso(before.startTs)} (${payload.deviceId}): ${bits.join(", ")}`;
    }
    case "delete_metric_point": {
      const label = before.source === "dailyMetric" ? "dailyMetric column" : "metricSeries key";
      return `DELETE ${label} ${payload.key}=${before.value} on ${payload.day} (${payload.deviceId})`;
    }
    case "set_baseline_note":
      return `NOTE${payload.deviceId ? ` [${payload.deviceId}]` : ""}: ${payload.note}`;
    case "edit_sleep_stages": {
      const oldStages = before.stagesJSON ? JSON.parse(before.stagesJSON) : null;
      return `RESTAGE sleep @ ${iso(before.startTs)} (${payload.deviceId}): ${stageSummary(oldStages)} ⇒ ${stageSummary(payload.stages)}`;
    }
    case "delete_hr_range":
      return `DELETE ${before.count} HR samples ${iso(payload.fromTs)} → ${iso(payload.toTs)} (${payload.deviceId})`;
  }
}
