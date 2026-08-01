import type { Annotation } from "./overlay.js";

/**
 * Suggested tag vocabulary — advertised by the `annotations` tool, NOT enforced by the schema.
 *
 * A closed enum would need a code change and a redeploy the first time VK reports something
 * unanticipated, and the annotation wouldn't get written that day, which defeats the point of
 * having somewhere to put ground truth. So the schema accepts any slug and this list is what the
 * tools advertise; `annotations` also returns the tags actually IN USE, so drift is visible
 * instead of silent (if `hangover` keeps showing up in `inUse`, it can be absorbed here later).
 *
 * This is the seam the future habit tracker grows from: a tag starts as free text, earns a place
 * in this list once it recurs, and eventually earns structure in `values`.
 */
export const KNOWN_TAGS = [
  "alcohol", "illness", "travel", "supplement_on", "supplement_off", "late_meal",
  "hard_workout", "medication", "injury", "stress", "caffeine", "poor_sleep",
  "fasting", "validation_night", "measurement_artifact",
] as const;

/** Slug shape a tag must match. Lowercase so `Alcohol` and `alcohol` can never split a group. */
export const TAG_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

export const ANNOTATION_SOURCES = ["user_reported", "agent_inferred"] as const;
export type AnnotationSource = (typeof ANNOTATION_SOURCES)[number];

/**
 * Why an annotation was attached to the day being reported on.
 *  - sameDay:      the annotation's own day IS this day.
 *  - priorEvening: the annotation is on the day BEFORE a sleep session's start day.
 *  - span:         this day falls inside a multi-day day..endDay range.
 */
export type MatchedOn = "sameDay" | "priorEvening" | "span";

export type SurfacedAnnotation = ReturnType<typeof surface>;

const DAY_MS = 86_400_000;
/** Calendar day before `day`, both "YYYY-MM-DD". Pure UTC arithmetic — no zone is involved,
 *  because both sides of the comparison are already local-day strings. */
export function dayBefore(day: string): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - DAY_MS).toISOString().slice(0, 10);
}

/** The compact form embedded into sleep_summary / health_snapshot / compare_sources rows.
 *  `detail` is NOT truncated: a half-quoted fact is worse than a long one, and the entire point
 *  of embedding is that a session reading the biometrics reads the explanation with them. */
function surface(a: Annotation, matchedOn: MatchedOn) {
  return {
    editId: a.editId, seq: a.seq, day: a.day, tags: a.tags, source: a.source,
    detail: a.detail, matchedOn,
    ...(a.endDay ? { endDay: a.endDay } : {}),
    ...(a.startTs !== null ? { startTs: a.startTs, startIso: new Date(a.startTs * 1000).toISOString() } : {}),
    ...(a.endTs !== null ? { endTs: a.endTs } : {}),
    ...(a.tz ? { tz: a.tz } : {}),
    ...(a.values ? { values: a.values } : {}),
  };
}

/**
 * Resolve how (or whether) one annotation bears on `day`. `includePriorEvening` is for SLEEP
 * sessions only, and is the load-bearing case: VK drank on the evening of 2026-07-30, but the
 * session it wrecked STARTS 2026-07-31 01:48 ET. Matching only on the session's own start day
 * would silently miss the exact case this store was built for.
 *
 * Order matters — sameDay beats span beats priorEvening — so an annotation that both starts a
 * span and lands on this day reports the more specific reason.
 */
function matchOn(a: Annotation, day: string, includePriorEvening: boolean): MatchedOn | null {
  if (a.day === day) return "sameDay";
  if (a.endDay && a.day < day && day <= a.endDay) return "span";
  if (includePriorEvening && a.day === dayBefore(day)) return "priorEvening";
  return null;
}

function collect(annotations: Annotation[], day: string, includePriorEvening: boolean) {
  const out: SurfacedAnnotation[] = [];
  for (const a of annotations) {
    const m = matchOn(a, day, includePriorEvening);
    if (m) out.push(surface(a, m));
  }
  return out.sort((x, y) => x.day.localeCompare(y.day) || x.seq - y.seq);
}

/** Annotations bearing on a calendar day: its own, plus any span covering it. */
export function annotationsOnDay(annotations: Annotation[], day: string): SurfacedAnnotation[] {
  return collect(annotations, day, false);
}

/** Annotations bearing on a sleep session that STARTS on `startDay` — same day, spans, and the
 *  prior evening (see matchOn). */
export function annotationsForNight(annotations: Annotation[], startDay: string): SurfacedAnnotation[] {
  return collect(annotations, startDay, true);
}

/** Tags actually present in the store, sorted — the `inUse` half of the advertised vocabulary. */
export function tagsInUse(annotations: Annotation[]): string[] {
  return [...new Set(annotations.flatMap((a) => a.tags))].sort();
}
