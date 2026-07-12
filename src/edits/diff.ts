import fs from "node:fs";
import Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { EditKind } from "./kinds.js";

export class EditTargetError extends Error {
  constructor(public code: "target_not_found" | "not_ingested", msg?: string) { super(msg ?? code); }
}

const iso = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z";

/** Read-only peek at the mirror for the row an edit targets. null for kinds with no target. */
export function captureBefore(cfg: Pick<Config, "mirrorPath">, kind: EditKind, payload: any): object | null {
  if (kind === "add_workout" || kind === "set_baseline_note") return null;
  if (!fs.existsSync(cfg.mirrorPath)) throw new EditTargetError("not_ingested");
  const db = new Database(cfg.mirrorPath, { readonly: true, fileMustExist: true });
  try {
    let row: unknown;
    if (kind === "fix_workout" || kind === "delete_workout") {
      row = db.prepare("SELECT * FROM workout WHERE deviceId=? AND startTs=? AND sport=?").get(payload.deviceId, payload.startTs, payload.sport);
    } else if (kind === "adjust_sleep_bounds") {
      row = db.prepare("SELECT * FROM sleepSession WHERE deviceId=? AND startTs=?").get(payload.deviceId, payload.startTs);
    } else if (kind === "delete_metric_point") {
      row = db.prepare("SELECT * FROM metricSeries WHERE deviceId=? AND day=? AND key=?").get(payload.deviceId, payload.day, payload.key);
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
    case "delete_metric_point":
      return `DELETE metric ${payload.key}=${before.value} on ${payload.day} (${payload.deviceId})`;
    case "set_baseline_note":
      return `NOTE${payload.deviceId ? ` [${payload.deviceId}]` : ""}: ${payload.note}`;
  }
}
