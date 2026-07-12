import { z } from "zod";

export const EDIT_KINDS = ["fix_workout", "delete_workout", "add_workout", "adjust_sleep_bounds", "delete_metric_point", "set_baseline_note"] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const workoutKey = { deviceId: z.string().min(1), startTs: z.number().int(), sport: z.string().min(1) };

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
};

export function payloadSchema(kind: EditKind): z.ZodTypeAny { return schemas[kind]; }
