import crypto from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { EDIT_KINDS, EditKind, payloadSchema, DAILY_METRIC_EDITABLE_COLUMNS } from "../edits/kinds.js";
import { captureBefore, renderDiff, EditTargetError } from "../edits/diff.js";
import { createProposal, listPending, journalSince, getProposal, resolveProposal, appendJournal, markUndone, journalEntryFor } from "../staging.js";

const asTool = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> });

export function registerWriteTools(server: McpServer, cfg: Config, scope: "ro" | "rw"): void {
  server.registerTool("propose_edit", {
    title: "Propose a data edit",
    description: "Stage a correction (nothing is applied until a human confirms with the read-write credential). Kinds: " + EDIT_KINDS.join(", ") + ". delete_metric_point's key can name either a metricSeries key or one of these dailyMetric columns to blank a single bad value: " + DAILY_METRIC_EDITABLE_COLUMNS.join(", ") + " — column deletes apply immediately to every server-side read (compare_sources, health_snapshot, metric_series fallback paths, fetch) but the phone-side sync doesn't understand column deletes yet (Phase 3 work): it will surface needsAttention and ack without changing local data. Returns a human-readable diff and the proposal id.",
    inputSchema: {
      kind: z.enum(EDIT_KINDS),
      payload: z.record(z.unknown()).describe("Kind-specific payload; see the kind's schema."),
      rationale: z.string().min(3).max(500).describe("Why this edit is correct — recorded in the audit journal."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (a) => {
    const parsed = payloadSchema(a.kind as EditKind).safeParse(a.payload);
    if (!parsed.success) return asTool({ error: "invalid_payload", detail: parsed.error.issues.map((i) => i.message).join("; ") });
    let before: object | null;
    try { before = captureBefore(cfg, a.kind as EditKind, parsed.data); }
    catch (e) {
      if (e instanceof EditTargetError) return asTool({ error: e.code }); // expected: no matching row
      console.error("propose_edit capture failed", e instanceof Error ? e.message : e);
      return asTool({ error: "capture_failed" });
    }
    const id = "edit_" + crypto.randomBytes(5).toString("hex");
    const diff = renderDiff(a.kind as EditKind, parsed.data, before);
    createProposal(cfg, { id, kind: a.kind, payloadJSON: JSON.stringify(parsed.data), rationale: a.rationale, beforeJSON: before ? JSON.stringify(before) : null, diffText: diff });
    return asTool({ id, kind: a.kind, diff, rationale: a.rationale, status: "pending", hint: "confirm_edit requires the read-write credential" });
  });

  server.registerTool("list_pending", {
    title: "List pending proposals",
    description: "Staged edits awaiting confirm/reject.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => asTool({ pending: listPending(cfg).map((p) => ({ id: p.id, kind: p.kind, diff: p.diffText, rationale: p.rationale, createdAt: p.createdAt })) }));

  server.registerTool("edit_journal", {
    title: "Edit journal",
    description: "Append-only audit log of every confirmed edit (and undos). since = last seq you have.",
    inputSchema: { since: z.number().int().min(0).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => {
    const edits = journalSince(cfg, a.since ?? 0);
    return asTool({ edits, latestSeq: edits.length ? edits[edits.length - 1].seq : (a.since ?? 0) });
  });

  if (scope === "rw") {
    registerResolutionTools(server, cfg); // Task 5
  }
}

// Task 5 implements: confirm_edit, reject_edit, undo_edit
export function registerResolutionTools(server: McpServer, cfg: Config): void {
  server.registerTool("confirm_edit", {
    title: "Confirm a proposed edit",
    description: "Apply a pending proposal to the edit journal + overlay. Requires the read-write credential. The mirror itself is never modified; corrections reach the phone in Phase 3.",
    inputSchema: { id: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (a) => {
    const resolved = resolveProposal(cfg, a.id, "confirmed");
    if (!resolved) {
      const existing = getProposal(cfg, a.id);
      if (existing?.status === "confirmed") {
        const row = journalEntryFor(cfg, a.id);
        if (row) return asTool({ id: a.id, seq: row.seq, applied: true, note: "already applied" });
        // Crash window: the proposal was marked confirmed but the process died before the journal
        // write landed. Self-heal by applying it now from the proposal's own stored fields.
        const seq = appendJournal(cfg, { editId: existing.id, kind: existing.kind, payloadJSON: existing.payloadJSON, beforeJSON: existing.beforeJSON, rationale: existing.rationale });
        return asTool({ id: a.id, seq, applied: true, note: "recovered — applied on retry" });
      }
      return asTool({ error: "not_pending" });
    }
    try {
      const seq = appendJournal(cfg, { editId: resolved.id, kind: resolved.kind, payloadJSON: resolved.payloadJSON, beforeJSON: resolved.beforeJSON, rationale: resolved.rationale });
      return asTool({ id: resolved.id, seq, applied: true, diff: resolved.diffText });
    } catch (e: any) {
      if (typeof e?.code === "string" && e.code.startsWith("SQLITE_CONSTRAINT")) {
        return asTool({ id: resolved.id, applied: true, note: "already applied" });
      }
      console.error("confirm_edit journal write failed", e?.message ?? e);
      return asTool({ error: "journal_write_failed", id: resolved.id });
    }
  });

  server.registerTool("reject_edit", {
    title: "Reject a proposed edit",
    description: "Discard a pending proposal (no journal entry, no data change).",
    inputSchema: { id: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (a) => {
    const r = resolveProposal(cfg, a.id, "rejected");
    return asTool(r ? { id: a.id, rejected: true } : { error: "not_pending" });
  });

  // Phase-3 replay must treat undo rows as idempotent: a crash between appendJournal(undo) and
  // markUndone below can leave a duplicate undo row targeting the same seq on retry — markUndone's
  // `undoneBySeq IS NULL` guard makes the second markUndone a no-op, and this is harmless.
  server.registerTool("undo_edit", {
    title: "Undo a confirmed edit",
    description: "Reverse a journal entry by appending an undo record (history is never deleted).",
    inputSchema: { seq: z.number().int().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (a) => {
    const target = journalSince(cfg, a.seq - 1).find((e) => e.seq === a.seq);
    if (!target || target.kind === "undo" || target.undoneBySeq !== null) return asTool({ error: "not_undoable" });
    const bySeq = appendJournal(cfg, { editId: "undo_" + crypto.randomBytes(5).toString("hex"), kind: "undo", payloadJSON: JSON.stringify({ targetSeq: a.seq }), beforeJSON: null, rationale: null });
    markUndone(cfg, a.seq, bySeq);
    return asTool({ undoneSeq: a.seq, bySeq });
  });
}
