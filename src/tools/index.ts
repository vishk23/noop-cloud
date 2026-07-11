import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { registerCoreTools } from "./core.js";
import { registerQueryTools } from "./query.js";

export function registerTools(server: McpServer, cfg: Config): void {
  registerCoreTools(server, cfg); // health_snapshot + data_freshness (Task 7)
  registerQueryTools(server, cfg); // metric_series + sleep_summary + workout_summary (Task 8)
  // Task 9: registerCompareSources(server, cfg)
  // Task 10: registerSearchFetch(server, cfg)
}
