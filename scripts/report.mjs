// Node 20+. Generates the morning report via the Anthropic Messages API MCP connector, pushes to ntfy.
const { ANTHROPIC_API_KEY, NOOP_CLOUD_URL, NOOP_RO_TOKEN, NTFY_TOPIC } = process.env;
const dryRun = process.argv.includes("--dry-run");
if (!ANTHROPIC_API_KEY || !NOOP_CLOUD_URL || !NOOP_RO_TOKEN) { console.error("missing env"); process.exit(2); }

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "mcp-client-2025-11-20",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "claude-sonnet-5",
    // Generous cap: the tool loop (freshness + snapshot + sleep/workout + compare) burns tokens
    // before the summary starts; 1024 risked a silent max_tokens truncation.
    max_tokens: 4096,
    messages: [{ role: "user", content: "Write my morning health report. Call data_freshness first and state the mirror age; if it is older than 36 hours, say so plainly. Then summarize the last 3 days (recovery/strain, sleep, resting HR + HRV trend, workouts) and flag any source disagreements via compare_sources. Under 200 words. No medical advice." }],
    mcp_servers: [{
      type: "url", url: `${NOOP_CLOUD_URL.replace(/\/$/, "")}/mcp`, name: "noop-cloud",
      authorization_token: NOOP_RO_TOKEN,
      tool_configuration: { enabled: true, allowed_tools: ["data_freshness", "health_snapshot", "sleep_summary", "workout_summary", "compare_sources", "metric_series"] },
    }],
  }),
});
if (!res.ok) { console.error("anthropic error", res.status, await res.text()); process.exit(1); }
const data = await res.json();
// A truncated turn (max_tokens) or unexpected stop must fail loudly, not push a partial report.
if (data.stop_reason && data.stop_reason !== "end_turn") {
  console.error("anthropic stop_reason", data.stop_reason, "— refusing to push a truncated report");
  process.exit(1);
}
const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || "(empty report)";

if (dryRun || !NTFY_TOPIC) { console.log(text); process.exit(0); }
const push = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, { method: "POST", headers: { Title: "NOOP morning report", Priority: "default" }, body: text });
if (!push.ok) { console.error("ntfy error", push.status); process.exit(1); }
console.log("pushed report to ntfy");
