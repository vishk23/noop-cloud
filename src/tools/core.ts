import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";

// Stub: Task 7 replaces these bodies with real Mirror-backed implementations
// (data_freshness -> mirror age + sources; health_snapshot -> per-day/per-family
// recovery/strain/sleep roll-up). This task (6) only needs the tool names to be
// registered so tools/list over /mcp is exercisable end-to-end.
const asTool = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> });

export function registerCoreTools(server: McpServer, _cfg: Config): void {
  server.registerTool("data_freshness", {
    title: "Data freshness",
    description: "How stale the mirror is and which sources it holds. Call this first.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => asTool({ ok: true, stub: true }));

  server.registerTool("health_snapshot", {
    title: "Health snapshot",
    description: "Recent per-day roll-up (recovery, strain, sleep, resting HR, HRV) grouped by source family.",
    inputSchema: { days: z.number().int().min(1).max(31).optional().describe("How many recent days (default 3).") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => asTool({ ok: true, stub: true }));
}
