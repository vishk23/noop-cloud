import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { registerCoreTools } from "./core.js";
import { registerQueryTools } from "./query.js";
import { registerCompareSources } from "./compare.js";
import { registerSearchFetch } from "./search-fetch.js";

export function registerTools(server: McpServer, cfg: Config): void {
  registerCoreTools(server, cfg); // health_snapshot + data_freshness (Task 7)
  registerQueryTools(server, cfg); // metric_series + sleep_summary + workout_summary (Task 8)
  registerCompareSources(server, cfg); // compare_sources (Task 9)
  registerSearchFetch(server, cfg); // search + fetch (Task 10)
}
