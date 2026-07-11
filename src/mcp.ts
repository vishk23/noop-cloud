import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { registerTools } from "./tools/index.js";

export function buildMcpServer(cfg: Config): McpServer {
  const server = new McpServer({ name: "noop-cloud", version: "0.1.0" });

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

  registerTools(server, cfg);
  return server;
}
