import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { registerCoreTools } from "./core.js";

export function registerTools(server: McpServer, cfg: Config): void {
  registerCoreTools(server, cfg); // health_snapshot + data_freshness (Task 7)
  // Task 8: registerQueryTools(server, cfg)
  // Task 9: registerCompareSources(server, cfg)
  // Task 10: registerSearchFetch(server, cfg)
}
