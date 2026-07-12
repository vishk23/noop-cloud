# noop-cloud

A self-hostable remote MCP server that mirrors a NOOP health database and exposes
read-only biometrics tools to Claude, ChatGPT, and agents over Streamable HTTP.

## Deploy (Fly.io)

```bash
fly launch --no-deploy --name <your-app>       # edit fly.toml app name
fly volumes create noop_data --size 1 --region iad
fly secrets set RO_TOKEN=$(openssl rand -hex 32) RW_TOKEN=$(openssl rand -hex 32)
fly deploy
```

Save the two tokens. `RW_TOKEN` uploads data; `RO_TOKEN` is for read clients (Claude Code, cron).

## Upload data (iOS Shortcut, no app changes)

In NOOP: **Settings → Backup & Sync → Back up now** to write a `.noopbak`. Then an iOS Shortcut:
"Get File → Get Contents of URL": `POST https://<app>.fly.dev/ingest`, header
`Authorization: Bearer <RW_TOKEN>`, request body = the file.

## Connect Claude Code

```bash
claude mcp add --transport http noop-cloud https://<app>.fly.dev/mcp \
  --header "Authorization: Bearer <RO_TOKEN>"
```

Then ask: "call data_freshness, then health_snapshot for the last 7 days."

## Tools

`data_freshness`, `health_snapshot`, `metric_series`, `sleep_summary`, `workout_summary`,
`compare_sources`, plus ChatGPT Deep Research `search`/`fetch`. Prompts: `morning_report`,
`corroborate_sources`, `find_messy_data`. All read-only in this phase.

## Morning report

A GitHub Actions cron (`.github/workflows/morning-report.yml`) calls the Anthropic Messages API
with this server as an MCP connector (read-only token, tool-allowlisted) and pushes the result to
[ntfy](https://ntfy.sh). Set repo secrets `ANTHROPIC_API_KEY`, `NOOP_CLOUD_URL`, `NOOP_RO_TOKEN`,
`NTFY_TOPIC` and subscribe to the topic in the ntfy app.

Local dry-run (prints, no push):

```bash
ANTHROPIC_API_KEY=… NOOP_CLOUD_URL=https://<app>.fly.dev NOOP_RO_TOKEN=… node scripts/report.mjs --dry-run
```
