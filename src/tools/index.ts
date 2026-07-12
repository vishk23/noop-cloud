import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { registerCoreTools } from "./core.js";
import { registerQueryTools } from "./query.js";
import { registerCompareSources } from "./compare.js";
import { registerSearchFetch } from "./search-fetch.js";
import { registerWriteTools } from "./writes.js";
import { registerGranularTools } from "./granular.js";

export function registerTools(server: McpServer, cfg: Config, scope: "ro" | "rw"): void {
  registerCoreTools(server, cfg); // health_snapshot + data_freshness (Task 7)
  registerQueryTools(server, cfg); // metric_series + sleep_summary + workout_summary (Task 8)
  registerCompareSources(server, cfg); // compare_sources (Task 9)
  registerSearchFetch(server, cfg); // search + fetch (Task 10)
  registerWriteTools(server, cfg, scope); // propose_edit/list_pending/edit_journal (+ rw-only resolution tools) (Task 4/5)
  registerGranularTools(server, cfg); // hr_series + sleep_detail (Phase 2b Task 1)
}
