import type { Config } from "../config.js";
import { computeOverlay, sleepKeyOf } from "./overlay.js";
import type { JournalRow } from "../staging.js";

export interface CompensationRow { kind: string; payloadJSON: string; rationale: string; }

function safeParse(s: string | null): any { if (s === null) return null; try { return JSON.parse(s); } catch { return null; } }

// The on-device stage JSON legend uses "wake"; the edit vocabulary (kinds.ts sleepStage enum, and
// what CloudEditApplier.mapServerStage expects to remap) uses "awake". A mirror-sourced stage set
// carries "wake", so normalize it back to the edit vocabulary before it re-enters the journal —
// otherwise the phone would store a "wake" that never round-trips through mapServerStage cleanly.
function toEditStageVocab(stage: string): string { return stage === "wake" ? "awake" : stage; }

/**
 * Builds a forward "compensating" edit that re-asserts the NET post-undo state of the target an undo
 * just reversed, so a phone that already applied the original edit in an EARLIER pull batch reverts to
 * the correct value. Without this, `CloudEditApplier` only ever skips the undo marker (and the undone
 * row it never re-pulls), leaving the earlier-applied change permanently stuck on-device (the
 * cross-batch bug: seq 41 applied+acked in one batch, its undo pulled in a later batch and skipped).
 *
 * MUST be called AFTER `markUndone(target)` — it reads `computeOverlay`, which already excludes the
 * undone row, so the emitted payload is the net remaining state (mirror baseline, or a still-active
 * stacked edit on the same night), not a naive rewind that would diverge from every server-side read.
 *
 * Returns null when the undone kind has no phone-applicable forward compensation:
 *  - set_baseline_note: server-only, the phone already ignores it.
 *  - delete_workout / delete_hr_range / delete_metric_point: undo restores data the phone physically
 *    deleted + tombstoned; no existing forward kind can un-tombstone/resurrect it on-device (the
 *    server overlay still resolves these undos correctly because the mirror is never mutated — this
 *    limitation is phone-side only, out of scope for this fix).
 *  - add_workout / fix_workout: reversible in principle but not part of this fix.
 * Also returns null when the payload can't be reconstructed (e.g. an edit_sleep_stages undo whose
 * pre-edit state was "no stored stages", which edit_sleep_stages cannot express — min 1 segment).
 */
export function compensationFor(cfg: Pick<Config, "serverDbPath">, target: JournalRow): CompensationRow | null {
  const payload = safeParse(target.payloadJSON);
  if (!payload || typeof payload.deviceId !== "string" || typeof payload.startTs !== "number") return null;
  const before = safeParse(target.beforeJSON);
  const rationale = `compensation: revert undone seq ${target.seq}`;

  if (target.kind === "adjust_sleep_bounds") {
    if (!before || typeof before.startTs !== "number" || typeof before.endTs !== "number") return null;
    const adj = computeOverlay(cfg).sleepBounds.get(sleepKeyOf(payload.deviceId, payload.startTs));
    // Net window = any still-active adjustment on this night, else the mirror's detected bounds.
    // Assert BOTH edges explicitly so the phone pins to exactly what every server read now returns.
    const newStartTs = adj?.newStartTs ?? before.startTs;
    const newEndTs = adj?.newEndTs ?? before.endTs;
    if (!(newEndTs > newStartTs)) return null; // never synthesize an inverted/degenerate window
    return { kind: "adjust_sleep_bounds", payloadJSON: JSON.stringify({ deviceId: payload.deviceId, startTs: payload.startTs, newStartTs, newEndTs }), rationale };
  }

  if (target.kind === "edit_sleep_stages") {
    const stageEdit = computeOverlay(cfg).stageEdits.get(sleepKeyOf(payload.deviceId, payload.startTs));
    // Net stages = a still-active stage edit on this night (already edit-vocabulary), else the
    // mirror's detected stagesJSON (device-vocabulary; normalized below).
    const raw = stageEdit ? stageEdit.stages : safeParse(before?.stagesJSON ?? null);
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const stages = raw
      .filter((s: any) => s && typeof s.start === "number" && typeof s.end === "number" && s.end > s.start && typeof s.stage === "string")
      .map((s: any) => ({ start: s.start, end: s.end, stage: toEditStageVocab(s.stage) }));
    if (stages.length === 0) return null;
    return { kind: "edit_sleep_stages", payloadJSON: JSON.stringify({ deviceId: payload.deviceId, startTs: payload.startTs, stages }), rationale };
  }

  return null;
}
