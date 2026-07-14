# noop-cloud

A self-hostable remote **MCP server for your NOOP health data.** It mirrors your NOOP
database and puts your WHOOP, Oura, and Apple Health biometrics behind Claude, ChatGPT, or
any agent over Streamable HTTP — so you can query them in natural language, cross-check one
wearable against another, drill into the raw sensor trace, and let the AI *propose*
corrections to mis-scored data, with every edit confirmed by you and reversible.

## What you can do

- **Talk to your biometrics.** Ask "how did I sleep this week?" or "show my resting-HR trend"
  and Claude/ChatGPT answers from your own data — no dashboard, no CSV wrangling.
- **Cross-check your sources.** `compare_sources` puts WHOOP, Oura, and Apple side by side for
  the same day, so you (and the AI) can catch which device is wrong when they disagree.
- **See the raw evidence, not just daily rollups.** Pull beat-to-beat heart rate, the full
  sleep hypnogram, R-R-interval HRV, and motion/IMU — enough for the AI to judge whether a
  flagged "wake" was real or just movement.
- **Let the AI fix your data — safely.** It can *propose* corrections (re-score a bad night,
  delete a bogus HR spike, re-stage a hypnogram). Nothing changes until you confirm with the
  write token; every edit is an append-only journal with a before-snapshot and one-command
  undo, and your uploaded data is never mutated. Read-only callers (cron, shared agents) can
  propose but never confirm.
- **Self-host in minutes, a couple dollars a month.** One small Fly machine — or plain Docker —
  plus SQLite. Upload via an iOS Shortcut of NOOP's existing `.noopbak` backup: zero app
  changes. Works with Claude Code, claude.ai, ChatGPT Deep Research, and any MCP client.

## How your data gets in — two paths

**Path A — backup upload (included here, no app changes).** An iOS Shortcut POSTs NOOP's
`.noopbak` to `/ingest`. That's it: every read tool and all the MCP-side editing below work
against that snapshot. This is the recommended way to start and it's fully self-contained in
this repo.

**Path B — live two-way sync (needs app-side integration, *not* in this repo).** The server
also speaks the endpoints for a much richer flow: background upload, push-to-sync
(`request_sync` → APNs → the phone uploads within ~a minute), and applying the AI's *confirmed*
edits back onto the device — so a correction you approve in Claude flows to your phone and
sticks. The server half lives here (`/register-device`, `/edits`, `/edits/ack`, `request_sync`);
the **client half — the CloudSync code inside the NOOP app that registers for push, handles it,
pulls the edit journal, applies it, and does pull-first / skip-unchanged uploads — is a separate
integration in the app and is not part of this repo.** Sections tagged **_(needs Path B)_** below
assume it. Want Path B for your own NOOP build? Open an issue or reach out — happy to share how
the client side works.

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
`RO_TOKEN`, `RW_TOKEN`, `MAX_INGEST_BYTES`, plus the optional `APNS_*` push credentials below —
pass them with `-e` or an `--env-file` instead of `fly secrets`. `better-sqlite3` is a native
module, so build the image on (or for) your target CPU architecture — the Dockerfile compiles it
during the build.

## Upload data (iOS Shortcut, no app changes)

In NOOP: **Settings → Backup & Sync → Back up now** to write a `.noopbak`. Then an iOS Shortcut:
"Get File → Get Contents of URL": `POST https://<app>.fly.dev/ingest`, header
`Authorization: Bearer <RW_TOKEN>`, request body = the file.

Every timestamp in an upload is epoch-UTC, so `POST /ingest` also accepts an optional
`X-Phone-Timezone` header carrying the phone's current IANA identifier (the app's in-app Cloud Sync
path sets it; the Shortcut can add it as a static header). It is validated against an IANA-id shape
(`Area/Location` or bare `UTC`) — anything else is stored as `NULL` — and recorded on the ingest
log row, so the server knows which zone the phone was in as of that upload. `data_freshness` returns
it as `phoneTz`, and `sleep_summary` attaches a per-night `tzId` by resolving each session's local
day (across the UTC-day boundary) against the phone's per-day `phoneTimezone` table when present.
Mirrors uploaded before that table shipped simply omit the field.

## Connect Claude Code

```bash
claude mcp add --transport http noop-cloud https://<app>.fly.dev/mcp \
  --header "Authorization: Bearer <RO_TOKEN>"
```

Then ask: "call data_freshness, then health_snapshot for the last 7 days."

## Tools

**Summaries & trends (read):** `data_freshness`, `health_snapshot`, `metric_series`,
`sleep_summary`, `workout_summary`, `compare_sources` (WHOOP vs Oura vs Apple corroboration).

**Raw sensor evidence (read):** `hr_series` (beat-level heart rate), `sleep_detail` (full
hypnogram + in-sleep HR), `hrv_series` (RMSSD from R-R intervals), `motion_series` (steps +
wrist posture), `imu_series` (WHOOP 5/MG activity).

**Edits — propose → confirm → journal → undo:** `propose_edit`, `list_pending`, `edit_journal`
(read token) and `confirm_edit`, `reject_edit`, `undo_edit` (**write token only**). Edit kinds
cover fixing/adding/deleting workouts, adjusting sleep bounds, re-staging hypnograms, deleting
artifact HR ranges, and blanking bogus metric points. See [Editing your data](#editing-your-data).

**On-demand sync:** `request_sync` pushes your phone to upload fresh data now (see
[Push-triggered on-demand sync](#push-triggered-on-demand-sync)).

**ChatGPT Deep Research:** `search` / `fetch`.  **Prompts:** `morning_report`,
`corroborate_sources`, `find_messy_data`.

## Push-triggered on-demand sync

> **Needs Path B (app integration).** This describes the live-sync flow. The server endpoints are
> here, but the phone must run the NOOP-app CloudSync integration (registration + push handling)
> for it to do anything — see [How your data gets in](#how-your-data-gets-in--two-paths). On a bare
> backup-upload deployment `request_sync` simply returns `{devices: 0}`.

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

## Editing your data

The AI can *propose* corrections; nothing changes until you confirm with the read-write credential.
The mirror (your uploaded data) is never modified — confirmed edits live in an append-only journal
and an overlay that read tools reflect (marked `edited: true` / `added: true`). Every proposal
records the original row (`before`), a human-readable diff, and the rationale; `undo_edit` reverses
by appending, so the audit trail is complete forever.

- Read-only callers (routines, cron, shared agents) can `propose_edit`, `list_pending`, `edit_journal`.
- `confirm_edit` / `reject_edit` / `undo_edit` exist **only** for read-write callers — invisible otherwise.
- `GET /edits?since=<seq>` (read token) streams the journal for downstream sync.
- **Cross-batch undo converges the phone.** When `undo_edit` reverses a sleep-bounds or sleep-stage
  edit, it also appends a forward **compensating** edit re-asserting the target's net post-undo state
  (computed from the overlay *after* the undo, so a still-active stacked edit on the same night wins
  over the mirror baseline). Without it, a phone that applied the original edit in an *earlier* pull
  batch would never see the undo (the applier skips undo markers and never re-pulls the undone row),
  leaving the change stuck on-device; the compensating row is an ordinary edit, so a device syncing
  from any cursor reverts. It is server-side only (heals every app version, zero phone change).
  `delete_*` / `add_*` / note kinds get no compensation — deletes would need on-device resurrection
  the phone can't do, and server reads already resolve those undos via the immutable mirror
  (`src/edits/compensation.ts`).
- Honesty note: `health_snapshot` / `compare_sources` aggregate the phone's own daily rollups; those
  numbers update after the phone applies your edits and re-uploads — which is the **_(needs Path B)_**
  apply-back leg. With backup-upload only (Path A), confirmed edits are reflected in the server's
  read tools via the overlay, but the phone's own rollups won't change until you edit on-device.

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
