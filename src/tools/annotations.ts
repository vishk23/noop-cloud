import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { computeOverlay, Annotation } from "../edits/overlay.js";
import { KNOWN_TAGS, ANNOTATION_SOURCES, tagsInUse } from "../edits/annotations.js";

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const asTool = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> });

/** An annotation overlaps [from, to] if any part of its day..endDay range does. A single-day
 *  annotation is the endDay === day case, so one comparison covers both. */
function overlapsRange(a: Annotation, from?: string, to?: string): boolean {
  const last = a.endDay ?? a.day;
  if (from && last < from) return false;
  if (to && a.day > to) return false;
  return true;
}

export function listAnnotations(cfg: Config, args: { from?: string; to?: string; tags?: string[]; source?: string; limit?: number }) {
  const all = computeOverlay(cfg).annotations;
  const wanted = args.tags?.length ? new Set(args.tags) : null;
  const matched = all
    .filter((a) => overlapsRange(a, args.from, args.to))
    .filter((a) => !wanted || a.tags.some((t) => wanted.has(t)))
    .filter((a) => !args.source || a.source === args.source)
    .sort((x, y) => x.day.localeCompare(y.day) || x.seq - y.seq);
  // Newest-first truncation, then re-sorted chronologically: a limit should drop the OLDEST
  // annotations, but the caller still wants what survives in reading order.
  const limit = args.limit ?? 200;
  const truncated = matched.length > limit;
  const annotations = (truncated ? matched.slice(-limit) : matched).map((a) => ({
    editId: a.editId, seq: a.seq, day: a.day, tags: a.tags, source: a.source, detail: a.detail,
    ...(a.endDay ? { endDay: a.endDay } : {}),
    ...(a.startTs !== null ? { startTs: a.startTs, startIso: new Date(a.startTs * 1000).toISOString() } : {}),
    ...(a.endTs !== null ? { endTs: a.endTs } : {}),
    ...(a.tz ? { tz: a.tz } : {}),
    ...(a.values ? { values: a.values } : {}),
    recordedAt: new Date(a.at * 1000).toISOString(),
    ...(a.rationale ? { rationale: a.rationale } : {}),
  }));
  return {
    annotations,
    total: all.length,
    matched: matched.length,
    ...(truncated ? { truncated: true, note: `showing the ${limit} most recent of ${matched.length} matches` } : {}),
    // Advertised so a caller can pick tags that group with what is already there, and so drift is
    // visible: a tag that keeps showing up in `inUse` but not `known` is a candidate for the list.
    vocabulary: { known: [...KNOWN_TAGS], inUse: tagsInUse(all) },
  };
}

/** Small enough to ride along in data_freshness — its job is only to say the store EXISTS and is
 *  worth querying, so an agent that calls data_freshness first doesn't have to already know. */
export function annotationSummary(annotations: Annotation[]) {
  if (!annotations.length) return { count: 0, tagsInUse: [] as string[] };
  const days = annotations.map((a) => a.endDay ?? a.day);
  return {
    count: annotations.length,
    firstDay: annotations.reduce((m, a) => (a.day < m ? a.day : m), annotations[0].day),
    lastDay: days.reduce((m, d) => (d > m ? d : m), days[0]),
    tagsInUse: tagsInUse(annotations),
  };
}

export function registerAnnotationTools(server: McpServer, cfg: Config): void {
  server.registerTool("annotations", {
    title: "Day annotations",
    description:
      "Dated life events and ground-truth context — alcohol, illness, travel, supplement protocol on/off, late meals, hard workouts, medication, known measurement artifacts. READ THIS BEFORE CONCLUDING THAT A DEVIATION IS PHYSIOLOGICAL: an annotation is often the difference between 'this night shows illness' and 'this is a labelled validation night'. Same-day annotations are also attached automatically to sleep_summary sessions (including the PRIOR EVENING, since an evening event bears on a night whose session starts after midnight), health_snapshot days and compare_sources days, so you normally get them without asking. `source` separates what VK reported (user_reported) from what an agent concluded (agent_inferred) — never treat the second as the first. Write one with propose_edit kind=add_annotation; remove one with undo_edit on its `seq`. For STANDING, undated context spanning a whole era (e.g. a supplement protocol that explains the entire WHOOP baseline) use set_baseline_note instead — it is surfaced by data_freshness.",
    inputSchema: {
      from: DAY.optional().describe("Earliest day (inclusive). Omit for no lower bound."),
      to: DAY.optional().describe("Latest day (inclusive). Omit for no upper bound."),
      tags: z.array(z.string()).optional().describe(`Match any of these tags. Suggested vocabulary: ${KNOWN_TAGS.join(", ")} — but the set is open, see the returned vocabulary.inUse.`),
      source: z.enum(ANNOTATION_SOURCES).optional(),
      limit: z.number().int().min(1).max(1000).optional().describe("Most recent N matches (default 200)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(listAnnotations(cfg, a)));
}
