import crypto from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { EDIT_KINDS, EditKind, payloadSchema } from "../edits/kinds.js";
import { captureBefore, renderDiff, EditTargetError } from "../edits/diff.js";
import { createProposal, listPending, journalSince } from "../staging.js";

const asTool = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> });

export function registerWriteTools(server: McpServer, cfg: Config, scope: "ro" | "rw"): void {
  server.registerTool("propose_edit", {
    title: "Propose a data edit",
    description: "Stage a correction (nothing is applied until a human confirms with the read-write credential). Kinds: " + EDIT_KINDS.join(", ") + ". Returns a human-readable diff and the proposal id.",
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
    catch (e) { return asTool({ error: e instanceof EditTargetError ? e.code : "capture_failed" }); }
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
export function registerResolutionTools(_server: McpServer, _cfg: Config): void {}
