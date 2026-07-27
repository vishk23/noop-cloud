# noop-cloud

**A self-hostable MCP server that puts your NOOP health data behind Claude/ChatGPT — read your biometrics in natural language, and propose · confirm · undo corrections without ever mutating your uploaded data.**

It mirrors your NOOP database (WHOOP, Oura, and Apple Health) and exposes it to any MCP client over Streamable HTTP: Node 20 + Express + SQLite, deployable to a single small Fly machine or plain Docker for a couple dollars a month.

- **Ask questions of your own data.** "How did I sleep this week?" / "Show my resting-HR trend" — answered from your biometrics, no dashboard or CSV wrangling.
- **Cross-check your wearables.** `compare_sources` puts WHOOP, Oura, and Apple side by side for the same day so you can catch which device is wrong when they disagree.
- **Drill into the raw evidence.** Beat-to-beat heart rate, the full sleep hypnogram, R-R-interval HRV, and motion/IMU — not just daily rollups — so the AI can judge whether a flagged "wake" was real or just movement.
- **Let the AI fix data — safely.** It can *propose* corrections; nothing changes until you confirm. Every edit is an append-only journal with a before-snapshot and one-command `undo_edit`, and your uploaded mirror is never mutated.
- **Read/write split by token.** Read clients (cron, shared agents) use `RO_TOKEN` and can propose but never confirm; only the `RW_TOKEN` can upload data and confirm/reject/undo edits.

> **Scope — two data paths.**
> **Path A — backup upload (fully in this repo).** An iOS Shortcut POSTs NOOP's existing `.noopbak` backup to `/ingest`; every read tool and all MCP-side editing work against that snapshot. Zero app changes — this is the recommended way to start.
> **Path B — live two-way sync (server endpoints here; phone side NOT in this repo).** The server also speaks the endpoints for push-to-sync (`request_sync` → APNs → the phone uploads) and applying *confirmed* edits back onto the device (`/register-device`, `/edits`, `/edits/ack`, `request_sync`). The **client half — the CloudSync code inside the NOOP app — is a separate integration and is not part of this repo.** Sections tagged **_(needs Path B)_** below assume it.

## Architecture

```
  iPhone (NOOP app)                          Fly.io machine  (or any Docker host)
  ┌───────────────────┐   POST /ingest       ┌────────────────────────────────────┐
  │ iOS Shortcut       │  Bearer RW_TOKEN     │  Node 20 + Express                  │
  │  .noopbak backup  ─┼─────────────────────▶│   ├─ SQLite mirror.sqlite (DATA_DIR)│
  └───────────────────┘                       │   └─ SQLite server.sqlite (edits)   │
                                              │            │                        │
   Claude / ChatGPT / any MCP client          │   MCP over Streamable HTTP          │
   ┌───────────────────┐   POST /mcp          │   POST /mcp  (Bearer RO_TOKEN)      │
   │  20 tools, 3      ◀┼──────────────────────┤   GET  /healthz → {ok:true}        │
   │  prompts          │  Bearer RO_TOKEN     └────────────────────────────────────┘
   └───────────────────┘
```

## Quick start (Fly.io)

```bash
fly launch --no-deploy --name <your-app>          # edit fly.toml app name
fly volumes create noop_data --size 1 --region iad
fly secrets set RO_TOKEN=$(openssl rand -hex 32) RW_TOKEN=$(openssl rand -hex 32)
fly deploy
```

Save the two tokens: `RW_TOKEN` uploads data and confirms edits; `RO_TOKEN` is for read clients (Claude Code, cron). Then upload a `.noopbak` (see [Upload data](#upload-data-ios-shortcut-no-app-changes)) and connect a client:

```bash
claude mcp add --transport http noop-cloud https://<app>.fly.dev/mcp \
  --header "Authorization: Bearer <RO_TOKEN>"
```

Then ask: "call data_freshness, then health_snapshot for the last 7 days."

## Docker alternative (any host)

Nothing here is Fly-specific: the runtime reads its whole config from env vars, and storage is a SQLite file in `DATA_DIR` — just a mounted directory. `fly.toml` is the only Fly artifact and is ignored off-Fly, so it runs anywhere Docker does (Compose, Kubernetes, a bare VM):

```bash
docker build -t noop-cloud .
docker run -p 8080:8080 \
  -e RO_TOKEN=$(openssl rand -hex 32) \
  -e RW_TOKEN=$(openssl rand -hex 32) \
  -v "$PWD/data:/data" \
  noop-cloud
```

The server listens on `:8080`; `GET /healthz` is the health check. Then `POST /ingest` a `.noopbak` with `Authorization: Bearer <RW_TOKEN>` and point any MCP client at `http://<host>:8080/mcp` with the `RO_TOKEN`.

**Environment variables:** `RO_TOKEN` and `RW_TOKEN` are required (each ≥32 chars). `DATA_DIR` (default `/data` in the image, `./data` otherwise), `PORT` (default `8080`), `MAX_INGEST_BYTES` (default `1073741824` = 1 GiB — a **disk** budget, not a memory one, since `/ingest` streams; keep it equal to `fly.toml`'s), `MIN_FREE_BYTES` (default `268435456` = 256 MiB), `STAGED_SWEEP_AGE_MS` (default `3600000` = 1h), plus the optional `APNS_KEY_P8` / `APNS_KEY_ID` / `APPLE_TEAM_ID` / `APNS_TOPIC` push credentials (see [Push-triggered on-demand sync](#push-triggered-on-demand-sync)). Pass them with `-e` or an `--env-file` instead of `fly secrets`. `better-sqlite3` is a native module, so build the image on (or for) your target CPU architecture — the Dockerfile compiles it during the build.

## Tools & prompts

28 MCP tools and 3 prompts, grouped by function (read-token tools are visible to every caller; write-token tools appear only for `RW_TOKEN` clients):

- **Summaries & trends (read, 6):** `data_freshness`, `health_snapshot`, `metric_series`, `sleep_summary`, `workout_summary`, `compare_sources` (WHOOP vs Oura vs Apple corroboration).
- **Raw sensor evidence (read, 7):** `hr_series` (beat-level heart rate), `sleep_detail` (full hypnogram + in-sleep HR), `sleep_state_series` (the hypnogram as a series), `hrv_series` (RMSSD from R-R intervals), `motion_series` (steps + wrist posture), `imu_series` (WHOOP 5/MG activity), `temp_series` (per-second skin temperature).
- **Device & capture inventory (read, 4):** `streams` (what raw streams exist and over what span), `battery_series` (strap state-of-charge), `device_events` (the strap's firmware event log), `imu_coverage` (deep-IMU capture availability).
- **Deep-buffer archive (read, 2):** `deep_buffer_coverage`, `deep_buffer_window` — read-only over the raw-buffer object store, available on every scope.
- **Edits — propose (read token, 3):** `propose_edit`, `list_pending`, `edit_journal`.
- **Edits — resolve (write token only, 3):** `confirm_edit`, `reject_edit`, `undo_edit`.
- **ChatGPT Deep Research (2):** `search`, `fetch`.
- **On-demand sync (1):** `request_sync` (pushes your phone to upload fresh data now — **_needs Path B_**).
- **Prompts (3):** `morning_report`, `corroborate_sources`, `find_messy_data`.

See [Editing your data](#editing-your-data) for the propose → confirm → journal → undo rail.

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

## Delta sync: page replication (`/liters/*`, optional, off by default)

Alongside the whole-database `POST /ingest`, the server can receive **page-level replication**: the
phone pushes changed 4 KB SQLite pages as LTX files — a few hundred KB per sync instead of 766 MB —
over [liters](https://github.com/mrkurt/liters)' own HTTP replication protocol. A small Rust sidecar
(`noop-liters-sink`, shipped in the image, embedding `liters_storage::HttpServer`) receives them and
materializes them into `mirror.sqlite`. All 19 MCP read call sites are unchanged: the result is a
plain on-disk SQLite file that `better-sqlite3` opens read-only, exactly as before.

**It is off unless `LITERS_SINK_ENABLED=1`**, and `POST /ingest` remains the fallback and the
recovery path whether it is on or not. With it off, `/liters/*` answers a legible 503 and no sidecar
process runs.

Read [`docs/LITERS_RECEIVE.md`](./docs/LITERS_RECEIVE.md) before turning it on — in particular the
lock hazard (a Node reader holding a SQLite transaction against a mirror being written in place), the
journal-mode invariant, and how `/ingest` and the liters lineage are kept from splicing.

## Storage health (`GET /status`)

`/ingest` performs an atomic swap: it stages a **second full copy** of the database next to the live
mirror, validates it, then renames it into place. So the volume must always hold roughly **2× the
mirror** plus slack, and "free space" is only meaningful relative to the mirror's own size.

The upload is **streamed end to end** — the request body goes straight to a `.staged-*.noopbak` on
the volume, and the database inside it is inflated from there to the staged path through a 64 KB
pipe. Nothing proportional to the database is ever held in memory, so `MAX_INGEST_BYTES` (1 GiB) is a
**disk** budget, not a memory one: a 961 MB database ingests with a ~150 MB peak RSS, the same as a
600 MB one. Growing the machine's RAM is never the fix for a large upload.

`GET /status` (needs `RO_TOKEN`) reports exactly that — disk free/total, mirror size, orphaned
staging bytes, and how long since the last successful ingest:

```bash
curl -sH "Authorization: Bearer $RO_TOKEN" https://<app>.fly.dev/status | jq
```

The field to watch is **`nextIngestFits`**. It goes `false` while there is still free space — as soon
as the volume can no longer absorb one more swap — which is the actionable moment, well before
anything breaks. `warnings[]` explains any non-`ok` state in words. The same block is returned by the
`data_freshness` MCP tool, so an agent sees storage health without a second call.

`GET /healthz` **always returns 200**, adding `degraded: true` and `warnings[]` when storage is
unhealthy. The 200 is deliberate: Fly's health check points at it, so a non-2xx would pull the
machine out of routing and block deploying the fix.

It is a *serving* check, not a liveness check. Besides disk, orphans and `server.sqlite`, it opens
the mirror the way the tools open it (`Mirror` + a `sqlite_master` read) and reports
`mirror.readable`. Without that a mirror corrupted in place left every other signal green — so
`/healthz` answered exactly `{"ok":true}` while every mirror-backed MCP tool was failing, which is
the same green-through-an-outage shape as the 2026-07-26 post-mortem below. No
`PRAGMA integrity_check`: that scans the whole file, and this runs every 30 s against 766 MB.

Guardrails, all exercised by `test/storage*.test.ts`, `test/ingest-space-guard.test.ts` and
`test/ingest-streaming.test.ts`:

- **Preflight, twice.** An upload with nowhere to land is refused up front with **507**
  `insufficient_space` (not 400 — the backup is valid and the phone should retry later): once
  against the declared `Content-Length` before the transfer is accepted, then again against the
  entry's decompressed size before the staged copy is written. A partial multi-hundred-MB write is
  never left behind.
- **Bounded output.** The decompressed ceiling is enforced *as the entry inflates*, not from the
  zip's own header — that field is attacker-controlled and can be forged to 0. A zip bomb costs one
  64 KB chunk.
- **No staged leaks.** The staged file and the `-wal`/`-shm` sidecars SQLite opens beside it are
  removed on every exit path, success included — `rename` moves only the main file.
- **Sweep.** `.staged-*` artifacts older than `STAGED_SWEEP_AGE_MS` (1h) are reclaimed at startup and
  before each ingest. The age guard is what makes this safe against an upload in flight.
- **Readable failures.** MCP tools answer a storage fault with an explanation naming the layer, the
  numbers, and the fix — never a bare driver string like `disk I/O error`.

> Post-mortem, 2026-07-26 (disk): the Fly volume filled to 3.0G/3.0G because ~2.4 GB of orphaned
> `.staged-*` files had accumulated — `writeFileSync` sat outside the try/catch, so once space got
> tight each failed ingest leaked a ~500 MB partial and made the next failure likelier. Every
> mirror-backed tool then returned `disk I/O error`, `/healthz` still said 200, and uploads had been
> silently failing for 8 days.
>
> Post-mortem, 2026-07-26 (memory): with the disk fixed, the next upload was **OOM-killed**
> (`anon-rss:1901376kB`) and the phone got a `502`. `/ingest` buffered the whole body with
> `express.raw`, gave it to AdmZip, and called `getData()` — three full copies of a 608 MB database
> in a 2 GB machine. Measured on that size: peak RSS **1993 MB before, 232 MB after**. RAM had
> already been doubled twice (512 MB → 1 GB → 2 GB) for the same failure, each doubling buying only
> the weeks it took the database to grow into it; streaming removed the scaling instead.

## Page-churn telemetry (`pageChurn` on `/status`)

Stage **P0** of [`docs/SYNC_BUILD_VS_BUY.md`](docs/SYNC_BUILD_VS_BUY.md), and a **falsification
experiment before it is a feature**. That document proposes replacing the whole-database upload with
page-level replication — ship only the changed 4 KB SQLite pages — and its entire case rests on one
number nobody had ever measured: how much of the file actually changes between two syncs. If routine
churn is ~1–3% the plan is right; if it is above ~10%, the plan is wrong and several weeks of work
are not worth starting.

At the instant of the atomic swap the server transiently holds **both** databases — the outgoing
mirror and the validated incoming snapshot — which is the only moment that diff can be counted. So
`src/pagechurn.ts` walks both files at the page size read from the SQLite header (bytes 16–17
big-endian; **never assumed to be 4096**) and records one row per ingest in `ingestPageChurn`:

```bash
curl -sH "Authorization: Bearer $RO_TOKEN" https://<app>.fly.dev/status | jq '.pageChurn[0]'
```

`deltaBytes` (what a page-diff upload *would* have carried, uncompressed) sits directly beside
`uploadBytes` (what `/ingest` actually carried, compressed), so the win — or its absence — needs no
arithmetic. Read the **series**, not one row: a single sync cannot tell "1% every time" apart from
"1% now, 40% after the next recompute". `bootstrap` and `pageSizeChanged` rows are flagged because
they are 100% by definition and are not churn evidence.

Two properties are load-bearing and both are pinned by `test/pagechurn.test.ts`:

- **It cannot fail an upload.** The ingest path only ever calls `measurePageChurn`, which converts
  every possible failure — unreadable mirror, corrupt header, short read, a missing table — into a
  logged `null`. The atomic swap below it is byte-for-byte unchanged, and a measurement that costs a
  sync would be worth less than no measurement.
- **It cannot grow memory.** Both files stream through two reused ~1 MiB buffers via positional
  `readSync`; neither is ever resident. Measured against the real 766 MB mirror **on the deployed
  shared-cpu-1x**: peak RSS **49.9 MB for the whole process**, of which the walk is ~3 MB. (On a
  local NVMe, a 776 MB → 786 MB pair compares in 256–381 ms at 74 MB peak RSS.)
- **It cannot starve the event loop.** The same Fly measurement puts a *cold* 766 MB walk at
  **35.9 s** — the volume reads at ~21 MB/s cold, then 682 ms and 145 ms once the page cache is warm.
  Node has one thread and Fly's service check on `/healthz` has a 5 s timeout, so a synchronous walk
  that long would pull the machine out of routing *during an ingest*. The walk therefore yields every
  64 MiB. `compareMs` records the real wall clock either way, so the cost is never a guess.

The report is scoped to `/status` on purpose: the same object is embedded in every `data_freshness`
MCP response and in `/healthz`, and an experiment's log does not belong in either. It is also outside
the `ok` verdict, so a telemetry fault can never turn a health check red.

## Push-triggered on-demand sync

> **Needs Path B (app integration).** This describes the live-sync flow. The server endpoints are
> here, but the phone must run the NOOP-app CloudSync integration (registration + push handling)
> for it to do anything — see the **Scope** note near the top. On a bare
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

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Vishnu Kchittibhooma.
