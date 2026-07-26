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

## Run with plain Docker (any host)

Nothing here is Fly-specific: the runtime is a Node 20 + Express + SQLite server that reads
its whole config from env vars, and storage is a SQLite file in `DATA_DIR` — just a mounted
directory. `fly.toml` is the only Fly artifact and is ignored off-Fly. So it runs anywhere
Docker does (Compose, Kubernetes, a bare VM):

```bash
docker build -t noop-cloud .
docker run -p 8080:8080 \
  -e RO_TOKEN=$(openssl rand -hex 32) \
  -e RW_TOKEN=$(openssl rand -hex 32) \
  -v "$PWD/data:/data" \
  noop-cloud
```

The server listens on `:8080`; `GET /healthz` is the health check. Then `POST /ingest` a
`.noopbak` with `Authorization: Bearer <RW_TOKEN>` and point any MCP client at `http://<host>:8080/mcp`
with the `RO_TOKEN`. Env vars: `DATA_DIR` (default `/data` in the image), `PORT` (8080),
`RO_TOKEN`, `RW_TOKEN`, `MAX_INGEST_BYTES`, `MIN_FREE_BYTES`, `STAGED_SWEEP_AGE_MS`,
plus the optional `APNS_*` push credentials below —
pass them with `-e` or an `--env-file` instead of `fly secrets`. `better-sqlite3` is a native
module, so build the image on (or for) your target CPU architecture — the Dockerfile compiles it
during the build.

## Storage health (`GET /status`)

`/ingest` performs an atomic swap: it stages a **second full copy** of the database next to the live
mirror, validates it, then renames it into place. So the volume must always hold roughly **2× the
mirror** plus slack, and "free space" is only meaningful relative to the mirror's own size.

`GET /status` (needs `RO_TOKEN`) reports exactly that — disk free/total, mirror size, orphaned
staging bytes, and how long since the last successful ingest:

```bash
curl -sH "Authorization: Bearer $RO_TOKEN" https://<app>.fly.dev/status | jq
```

The field to watch is **`nextIngestFits`**. It goes `false` while there is still free space — as soon
as the volume can no longer absorb one more swap — which is the actionable moment, well before
anything breaks. `warnings[]` explains any non-`ok` state in words. The same block is returned by the
`data_freshness` MCP tool, so an agent sees storage health without a second call.

`GET /healthz` stays a pure liveness probe and **always returns 200**, adding `degraded: true` and
`warnings[]` when storage is unhealthy. That is deliberate: Fly's health check points at it, so a
non-2xx would pull the machine out of routing and block deploying the fix.

Guardrails, all exercised by `test/storage*.test.ts` and `test/ingest-space-guard.test.ts`:

- **Preflight.** An upload with nowhere to land is refused up front with **507** `insufficient_space`
  (not 400 — the backup is valid and the phone should retry later), so a partial multi-hundred-MB
  write is never left behind.
- **No staged leaks.** The staged file and the `-wal`/`-shm` sidecars SQLite opens beside it are
  removed on every exit path, success included — `rename` moves only the main file.
- **Sweep.** `.staged-*` artifacts older than `STAGED_SWEEP_AGE_MS` (1h) are reclaimed at startup and
  before each ingest. The age guard is what makes this safe against an upload in flight.
- **Readable failures.** MCP tools answer a storage fault with an explanation naming the layer, the
  numbers, and the fix — never a bare driver string like `disk I/O error`.

> Post-mortem, 2026-07-26: the Fly volume filled to 3.0G/3.0G because ~2.4 GB of orphaned
> `.staged-*` files had accumulated — `writeFileSync` sat outside the try/catch, so once space got
> tight each failed ingest leaked a ~500 MB partial and made the next failure likelier. Every
> mirror-backed tool then returned `disk I/O error`, `/healthz` still said 200, and uploads had been
> silently failing for 8 days.

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
`compare_sources`, `request_sync`, plus ChatGPT Deep Research `search`/`fetch`. Prompts:
`morning_report`, `corroborate_sources`, `find_messy_data`. All read-only in this phase.

## Push-triggered on-demand sync

`request_sync` asks the phone to sync right now via a visible APNs alert push (priority 10, with
`content-available` so it also wakes the app in the background to upload) instead of waiting for its
normal schedule — call it, then poll `data_freshness` until `mirrorAgeSeconds` resets. A silent
(content-available-only) background push was tried first but iOS budget-throttles those and drops
them under Low Power Mode / Background App Refresh off, so repeat calls never woke the phone. It's
throttled to one push per 120s server-wide and never throws: with no push credentials configured
it returns `{configured: false}`, and with credentials but no registered phone it returns
`{devices: 0}`.

Requires an Apple Developer APNs Auth Key (.p8) and four Fly secrets:

```bash
fly secrets set \
  APNS_KEY_P8="$(cat AuthKey_XXXXXXXXXX.p8)" \
  APNS_KEY_ID=XXXXXXXXXX \
  APPLE_TEAM_ID=YOUR_TEAM_ID \
  APNS_TOPIC=com.yourorg.NOOP
```

The phone registers for remote notifications and calls `POST /register-device` (read-write
credential) with `{token, platform: "ios"}` on every app open, so a reinstalled/restored phone
re-registers automatically. It must also hold User Notification authorization for the alert banner
to display (the app requests it on the Cloud Sync path).

## Morning report

A GitHub Actions cron (`.github/workflows/morning-report.yml`) calls the Anthropic Messages API
with this server as an MCP connector (read-only token, tool-allowlisted) and pushes the result to
[ntfy](https://ntfy.sh). Set repo secrets `ANTHROPIC_API_KEY`, `NOOP_CLOUD_URL`, `NOOP_RO_TOKEN`,
`NTFY_TOPIC` and subscribe to the topic in the ntfy app.

`NTFY_TOPIC` is a SECRET, not a public slug — ntfy topics are unauthenticated, so anyone who
knows or guesses it can subscribe to `https://ntfy.sh/<topic>` and read your daily health push;
generate one like `noop-$(openssl rand -hex 16)` instead of a guessable name.

Local dry-run (prints, no push):

```bash
ANTHROPIC_API_KEY=… NOOP_CLOUD_URL=https://<app>.fly.dev NOOP_RO_TOKEN=… node scripts/report.mjs --dry-run
```

## Editing your data (Phase 2)

The AI can *propose* corrections; nothing changes until you confirm with the read-write credential.
The mirror (your uploaded data) is never modified — confirmed edits live in an append-only journal
and an overlay that read tools reflect (marked `edited: true` / `added: true`). Every proposal
records the original row (`before`), a human-readable diff, and the rationale; `undo_edit` reverses
by appending, so the audit trail is complete forever.

- Read-only callers (routines, cron, shared agents) can `propose_edit`, `list_pending`, `edit_journal`.
- `confirm_edit` / `reject_edit` / `undo_edit` exist **only** for read-write callers — invisible otherwise.
- `GET /edits?since=<seq>` (read token) streams the journal for downstream sync.
- Honesty note: `health_snapshot` / `compare_sources` aggregate the phone's own daily rollups; those
  numbers update after the phone applies your edits (Phase 3) and re-uploads.

### Granular evidence & edits

`hr_series` (raw or bucketed heart-rate for any window, ≤7 days) and `sleep_detail` (a night's full
hypnogram + in-sleep HR) let the AI check the actual sensor evidence — e.g. "HR stayed at 48bpm and
flat until 06:00, so that 03:00 'wake' was movement, not waking." `motion_series` (bucketed step
counts + wrist posture/gravity) adds movement evidence — combined with `hr_series` it distinguishes
"awake in bed" (no steps, unchanged posture) from "up and about" (steps, posture change);
`sleep_detail` folds the same evidence into `motion: { steps, postureChanges }` for a session.
Motion tools return empty/`null` (never throw) against a mirror uploaded before this feature shipped.
`hrv_series` (bucketed RMSSD + mean HR from raw beat-to-beat R-R intervals, ≤7 days) surfaces daytime
HRV without pulling the phone. R-R data is WHOOP-era only — `rrAvailable:false` for oura-api or any
pre-WHOOP range, since the Oura API never exposes beat-to-beat timing — and a bucket with too few
clean intervals reports `rmssd:null` rather than a fabricated number.
Then `edit_sleep_stages` rewrites the night's stage timeline and `delete_hr_range` throws out
artifact heart-rate stretches — through the same propose → confirm → journal → undo rail as every
other edit.
