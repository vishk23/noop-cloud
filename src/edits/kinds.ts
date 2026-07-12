import { z } from "zod";

export const EDIT_KINDS = ["fix_workout", "delete_workout", "add_workout", "adjust_sleep_bounds", "delete_metric_point", "set_baseline_note", "edit_sleep_stages", "delete_hr_range"] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

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
    stages: z.array(sleepStage).min(1).max(96),
  }).strict()
    .refine((p) => p.stages.every((s) => s.end > s.start), "every stage must have end > start")
    .refine((p) => p.stages.every((s, i) => i === 0 || p.stages[i - 1].end === s.start), "stages must be ascending and contiguous"),
  delete_hr_range: z.object({
    deviceId: z.string().min(1), fromTs: z.number().int(), toTs: z.number().int(),
  }).strict().refine((p) => p.toTs > p.fromTs && p.toTs - p.fromTs <= 21_600, "toTs must be after fromTs and within 6 hours"),
};

export function payloadSchema(kind: EditKind): z.ZodTypeAny { return schemas[kind]; }
