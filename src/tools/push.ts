import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { countDeviceTokens, getLastPushAt, setLastPushAt } from "../push/registry.js";
import { isApnsConfigured, sendSyncPush, type SendFn } from "../push/apns.js";
import { dataFreshness } from "./core.js";

const THROTTLE_S = 120;
const EXPECT_FRESH_WITHIN_S = 90;

const asTool = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> });

// `send` is only ever supplied by tests (see src/push/apns.ts's SendFn seam) — the registered MCP
// tool below always uses the real HTTP/2 transport.
export async function requestSync(cfg: Config, send?: SendFn) {
  if (!isApnsConfigured(cfg)) {
    return { configured: false, hint: "set APNS_KEY_P8/APNS_KEY_ID/APPLE_TEAM_ID/APNS_TOPIC fly secrets" };
  }
  const devices = countDeviceTokens(cfg);
  if (devices === 0) {
    return { configured: true, devices: 0, hint: "open NOOP once so the phone registers" };
  }
  const last = getLastPushAt(cfg);
  const now = Math.floor(Date.now() / 1000);
  if (last !== null && now - last < THROTTLE_S) {
    return { throttled: true, retryInSec: THROTTLE_S - (now - last) };
  }
  setLastPushAt(cfg, now);
  const { pushed } = await sendSyncPush(cfg, send);
  return {
    pushed,
    mirrorAgeSeconds: dataFreshness(cfg).mirrorAgeSeconds,
    expectFreshWithinSec: EXPECT_FRESH_WITHIN_S,
    hint: "poll data_freshness until mirrorAgeSeconds resets",
  };
}

export function registerPushTools(server: McpServer, cfg: Config): void {
  server.registerTool("request_sync", {
    title: "Request on-demand phone sync",
    description:
      "Ask the phone to sync fresh data right now instead of waiting for its normal schedule — use this before " +
      "reading data you suspect is stale. Workflow: call request_sync, then poll data_freshness every few seconds " +
      "(expect mirrorAgeSeconds to reset within ~" + EXPECT_FRESH_WITHIN_S + "s), then read the now-fresh data. " +
      "Throttled to one push per " + THROTTLE_S + "s server-wide, regardless of caller. Needs both: the server has " +
      "push credentials configured (APNS_KEY_P8/APNS_KEY_ID/APPLE_TEAM_ID/APNS_TOPIC) and the phone has registered " +
      "a device token via POST /register-device — if either is missing this returns a hint instead of pushing, " +
      "it never throws.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => asTool(await requestSync(cfg)));
}
