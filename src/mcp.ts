import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { registerTools } from "./tools/index.js";
import { isStorageError, storageFailureMessage } from "./storage.js";

/**
 * Make every tool answer a storage fault with an explanation instead of a driver string.
 *
 * On 2026-07-26 the Fly volume hit 0 bytes free and every mirror-backed tool returned exactly
 * `disk I/O error` — no indication of which layer failed, whether the caller's arguments were
 * wrong, or whether retrying would help. It reads like a client bug and is not one.
 *
 * Wrapping registerTool (rather than each handler) means this covers the tools registered below AND
 * any tool added later, with no opt-in step to forget. Non-storage errors propagate untouched, so
 * ordinary validation failures keep their existing behaviour. `isError: true` is the MCP-native way
 * to fail a single tool call without tearing down the session — and the SDK deliberately skips
 * outputSchema validation for error results, so this stays legal on tools that declare one.
 */
function installStorageGuard(server: McpServer, cfg: Config): void {
  const original = server.registerTool.bind(server);
  (server as unknown as Record<string, unknown>).registerTool = (
    name: string, config: unknown, handler: (...a: unknown[]) => unknown,
  ) => original(name as never, config as never, (async (...args: unknown[]) => {
    try {
      return await handler(...args);
    } catch (e) {
      if (!isStorageError(e)) throw e;
      console.error(`tool ${name} storage failure:`, e instanceof Error ? e.message : e);
      return { isError: true, content: [{ type: "text" as const, text: storageFailureMessage(cfg, e) }] };
    }
  }) as never);
}

export function buildMcpServer(cfg: Config, scope: "public" | "ro" | "rw"): McpServer {
  const server = new McpServer({ name: "noop-cloud", version: "0.1.0" });
  installStorageGuard(server, cfg);

  server.registerPrompt("morning_report", {
    title: "Morning report",
    description: "Draft a plain-English morning briefing from the last few days of biometrics.",
  }, () => ({
    messages: [{ role: "user", content: { type: "text", text:
      "Using the noop-cloud tools, write my morning report. Call data_freshness first and state the mirror age. " +
      "Then summarize the last 3 days: recovery/strain (WHOOP), sleep (duration, efficiency), resting HR and HRV trend, " +
      "and any workouts. Use compare_sources to flag where WHOOP, Oura, and Apple disagree by more than ~10%. " +
      "Keep it under 200 words, concrete, no medical advice." } }],
  }));

  server.registerPrompt("corroborate_sources", {
    title: "Corroborate sources",
    description: "Cross-check WHOOP vs Oura vs Apple for a date range and surface disagreements.",
  }, () => ({
    messages: [{ role: "user", content: { type: "text", text:
      "Call compare_sources for the last 14 days. List days where resting HR, HRV, or sleep duration differ by more than 10% " +
      "across sources, and say which source looks like the outlier. Note any per-source baseline offsets." } }],
  }));

  server.registerPrompt("find_messy_data", {
    title: "Find messy data",
    description: "Scan recent data for likely-mislogged workouts or implausible values.",
  }, () => ({
    messages: [{ role: "user", content: { type: "text", text:
      "Call workout_summary and metric_series for the last 30 days. Flag workouts with implausible duration/distance/energy, " +
      "duplicate workouts across sources on the same day, and daily values that break trend. Do not change anything — just list findings." } }],
  }));

  registerTools(server, cfg, scope);
  return server;
}
