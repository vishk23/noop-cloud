import { z } from "zod";
import { TAG_PATTERN, ANNOTATION_SOURCES } from "./annotations.js";

export const EDIT_KINDS = ["fix_workout", "delete_workout", "add_workout", "adjust_sleep_bounds", "delete_metric_point", "set_baseline_note", "edit_sleep_stages", "delete_hr_range", "add_annotation"] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

// delete_metric_point's `key` originally only ever named a metricSeries key. It now also accepts
// one of these dailyMetric column names, letting a single bad dailyMetric value (e.g. a spiked
// restingHr) be blanked directly instead of only ever being reachable through the metricSeries
// fallback path. Curated allowlist, not every dailyMetric column (see mirror.ts's
// dailyMetricColumns() for the full introspected set): scoped to the columns worth a targeted
// point-delete, not incidental ones like respRateBpm/activeKcalEst.
export const DAILY_METRIC_EDITABLE_COLUMNS = ["restingHr", "avgHrv", "spo2Pct", "steps", "totalSleepMin", "efficiency", "skinTempDevC", "recovery", "strain"] as const;
const DAILY_METRIC_EDITABLE_COLUMN_SET = new Set<string>(DAILY_METRIC_EDITABLE_COLUMNS);
export function isDailyMetricColumnKey(key: string): boolean { return DAILY_METRIC_EDITABLE_COLUMN_SET.has(key); }

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const workoutKey = { deviceId: z.string().min(1), startTs: z.number().int(), sport: z.string().min(1) };
const sleepStage = z.object({ start: z.number().int(), end: z.number().int(), stage: z.enum(["awake", "light", "deep", "rem"]) });

const schemas: Record<EditKind, z.ZodTypeAny> = {
  fix_workout: z.object({
    ...workoutKey,
    patch: z.object({
      sport: z.string().min(1).optional(), startTs: z.number().int().optional(), endTs: z.number().int().optional(),
      energyKcal: z.number().nullable().optional(), distanceM: z.number().nullable().optional(),
    }).refine((p) => Object.keys(p).length > 0, "patch must not be empty"),
  }).strict(),
  delete_workout: z.object(workoutKey).strict(),
  add_workout: z.object({
    startTs: z.number().int(), endTs: z.number().int(), sport: z.string().min(1),
    energyKcal: z.number().optional(), distanceM: z.number().optional(), notes: z.string().max(500).optional(),
  }).strict().refine((p) => p.endTs > p.startTs, "endTs must be after startTs"),
  adjust_sleep_bounds: z.object({
    deviceId: z.string().min(1), startTs: z.number().int(),
    newStartTs: z.number().int().optional(), newEndTs: z.number().int().optional(),
  }).strict().refine((p) => p.newStartTs !== undefined || p.newEndTs !== undefined, "need newStartTs and/or newEndTs"),
  delete_metric_point: z.object({ deviceId: z.string().min(1), day: DAY, key: z.string().min(1) }).strict(),
  set_baseline_note: z.object({ note: z.string().min(1).max(500), deviceId: z.string().min(1).optional() }).strict(),
  edit_sleep_stages: z.object({
    deviceId: z.string().min(1), startTs: z.number().int(),
    // Raised from 96 after a real fragmented night (5.0 strap, fine-grained hypnogram) produced 114
    // stage segments and got rejected outright (audit-exposed: the cap was rejecting genuine data, not
    // just malformed payloads). 256 bounds the payload at ~15KB (each stage segment serializes to
    // roughly 60 bytes of JSON) while covering even a heavily fragmented 9-10h night.
    stages: z.array(sleepStage).min(1).max(256),
  }).strict()
    .refine((p) => p.stages.every((s) => s.end > s.start), "every stage must have end > start")
    .refine((p) => p.stages.every((s, i) => i === 0 || p.stages[i - 1].end === s.start), "stages must be ascending and contiguous"),
  delete_hr_range: z.object({
    deviceId: z.string().min(1), fromTs: z.number().int(), toTs: z.number().int(),
  }).strict().refine((p) => p.toTs > p.fromTs && p.toTs - p.fromTs <= 21_600, "toTs must be after fromTs and within 6 hours"),
  // A dated life event (see docs/ANNOTATIONS_DESIGN.md). Distinct from set_baseline_note, which is
  // STANDING context with no time and only one visible note per deviceId — a second dated event
  // written as a baseline note silently hides the first.
  //
  // `day` is required and every other time field is optional on purpose: most of what VK reports is
  // day-grained ("Thursday I drank"), and forcing an instant would mean inventing precision. `day`
  // stays mandatory so every annotation has exactly one unambiguous anchor to join a night onto.
  add_annotation: z.object({
    day: DAY,
    endDay: DAY.optional().describe("Inclusive last day of a multi-day span (travel, a supplement block)."),
    startTs: z.number().int().optional(), endTs: z.number().int().optional(),
    tags: z.array(z.string().regex(TAG_PATTERN, "tags must match ^[a-z][a-z0-9_]{1,31}$")).min(1).max(8),
    detail: z.string().min(1).max(2000),
    // Required, and never guessed: user_reported is ground truth VK stated, agent_inferred is a
    // conclusion drawn from the data. Collapsing them lets an inference harden into a fact across
    // sessions, which is exactly how a retracted claim gets born.
    source: z.enum(ANNOTATION_SOURCES),
    tz: z.string().min(1).max(64).optional().describe("IANA zone that `day` is a calendar day in."),
    // Flat, scalar-only, and read by no tool today. It exists so the future habit tracker can record
    // "6 drinks" as 6 rather than buried in prose — the mistake set_baseline_note forces.
    values: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
  }).strict()
    .refine((p) => !p.endDay || p.endDay >= p.day, "endDay must not precede day")
    .refine((p) => p.endTs === undefined || (p.startTs !== undefined && p.endTs > p.startTs), "endTs requires startTs and must be after it")
    .refine((p) => !p.values || Object.keys(p.values).length <= 20, "values holds at most 20 keys")
    .refine((p) => new Set(p.tags).size === p.tags.length, "tags must be unique"),
};

export function payloadSchema(kind: EditKind): z.ZodTypeAny { return schemas[kind]; }
