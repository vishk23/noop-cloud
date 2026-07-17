import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { registerCoreTools } from "./core.js";
import { registerQueryTools } from "./query.js";
import { registerCompareSources } from "./compare.js";
import { registerSearchFetch } from "./search-fetch.js";
import { registerWriteTools } from "./writes.js";
import { registerGranularTools } from "./granular.js";
import { registerPushTools } from "./push.js";

// "public" is the strict read-only surface served on the no-auth URL-secret route (POST /mcp/:secret):
// pure reads only, so an anonymous caller (e.g. ChatGPT's "No Auth" connector, or anything that gets
// hold of the URL) can never stage an edit proposal or poke the phone. "ro"/"rw" are the bearer-token
// scopes and additionally get the write-proposal and push tools.
export function registerTools(server: McpServer, cfg: Config, scope: "public" | "ro" | "rw"): void {
  registerCoreTools(server, cfg); // health_snapshot + data_freshness (Task 7)
  registerQueryTools(server, cfg); // metric_series + sleep_summary + workout_summary (Task 8)
  registerCompareSources(server, cfg); // compare_sources (Task 9)
  registerSearchFetch(server, cfg); // search + fetch (Task 10)
  registerGranularTools(server, cfg); // hr_series + sleep_detail (Phase 2b Task 1)
  if (scope !== "public") {
    registerWriteTools(server, cfg, scope); // propose_edit/list_pending/edit_journal (+ rw-only resolution tools) (Task 4/5)
    registerPushTools(server, cfg); // request_sync — pokes the phone; not for anonymous URL callers
  }
}
