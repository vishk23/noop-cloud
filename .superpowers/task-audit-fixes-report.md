# Audit fixes report

Four audit-discovered defects in the noop-cloud MCP server, fixed and deployed 2026-07-13.

## Fix 1 — compare_sources drops days with no dailyMetric row

**Problem:** `compareSources` built its day universe from `m.dailyMetrics(...)` rows only, so a day
whose only evidence was a metricSeries fallback row (e.g. Apple steps on a day no wearable wrote a
dailyMetric row) was silently omitted from the output.

**Fix:** `src/tools/compare.ts` — the day universe is now the union of dailyMetric days and
metricSeries fallback days (`allDays = new Set(byDay.keys())`, extended with every `seriesRows.day`).
Existing per-metric precedence (dailyMetric wins per family; fallback only fills families with no
dailyMetric value that day) is unchanged — only the set of days iterated changed.

**Files changed:** `src/tools/compare.ts`

**Tests added:**
- `test/tools-compare.test.ts` — new describe block "compare_sources day universe: metricSeries-only
  day (post-hoc audit fix)": builds an isolated mirror (own dataDir, `buildMirrorSqlite` +
  `buildNoopbakFrom` + `ingestNoopbak`, matching the `tools-motion-dense.test.ts` pattern) with a day
  that has a metricSeries `apple-health/steps` row and **no** dailyMetric row at all, and asserts the
  day now appears in `compareSources` output with the fallback value.

**Commit:** `f62cec1` — `fix(compare_sources): include days whose only evidence is a metricSeries fallback row`

## Fix 2 — delete_metric_point cannot touch dailyMetric columns

**Problem:** `delete_metric_point`'s overlay only ever filtered `metricSeries` rows, so the
confirmed-bogus data point (a dailyMetric `restingHr` outlier for `oura-api`, well above its
neighboring days) had no correction path — the kind couldn't target a dailyMetric column at all.

**Fix:** Extended the *existing* `delete_metric_point` kind (no new kind added, `EDIT_KINDS.length`
stays 8):
- `src/edits/kinds.ts` — new `DAILY_METRIC_EDITABLE_COLUMNS` allowlist (`restingHr`, `avgHrv`,
  `spo2Pct`, `steps`, `totalSleepMin`, `efficiency`, `skinTempDevC`, `recovery`, `strain`) and
  `isDailyMetricColumnKey()` helper.
- `src/edits/diff.ts` — `captureBefore` now branches: if `payload.key` is an allowlisted column
  name, it looks up the `dailyMetric` row for `(deviceId, day)` and snapshots `{source:
  "dailyMetric", value}` (throwing `target_not_found` if the row or column value is missing);
  otherwise it falls through to the original metricSeries lookup, now tagged `{source:
  "metricSeries", ...}`. `renderDiff` labels the diff text accordingly ("dailyMetric column" vs
  "metricSeries key").
- The **existing** `computeOverlay`/`deletedMetricPoints` mechanism needed no changes — it's already
  keyed opaquely on `(deviceId, day, key)` via `pointKeyOf`, so it works for column-kind deletes for
  free.
- Applied the overlay to every read surface that serves dailyMetric values (audited every
  `dailyMetrics(` call site):
  - `src/tools/compare.ts` — `compareSources`'s per-family collection loop now skips a dailyMetric
    value whose `(deviceId, day, metric)` is in the deletion overlay, which also correctly frees that
    family up for the metricSeries fallback (same code path a genuinely-null value already takes).
  - `src/tools/core.ts` — `healthSnapshot`'s field-merge loop applies the same skip.
  - `src/tools/search-fetch.ts` — `fetch()`'s per-day digest text applies the same skip (this
    surface wasn't explicitly named as a required test target but does read dailyMetric columns
    directly, so it's covered per the "audit each `dailyMetrics(` call" instruction).
  - `src/tools/search-fetch.ts`'s `search()` only reads `.day` (no column values), so it needed no
    change.
- `src/tools/writes.ts` — `propose_edit`'s description now names the allowlisted columns and states
  the phone-side sync limitation: column deletes apply immediately server-side but the phone-side
  applier doesn't understand column deletes yet (Phase 3 work) — it will surface `needsAttention` and
  ack without applying. No phone-side code was touched (out of this repo's scope).

**Files changed:** `src/edits/kinds.ts`, `src/edits/diff.ts`, `src/tools/compare.ts`,
`src/tools/core.ts`, `src/tools/search-fetch.ts`, `src/tools/writes.ts`

**Tests added:**
- `test/edits-diff.test.ts` — 3 unit tests: dailyMetric-column resolution (`oura-api`/`restingHr`/`53`),
  metricSeries-key resolution still works for a non-column key (`oura_readiness`/`78`), and
  `target_not_found` when the allowlisted column has no value (`apple-health`/`avgHrv`, null in the
  fixture).
- `test/tools-compare.test.ts` — new test in the existing overlay describe block: deleting
  `oura-api/restingHr` hides it from `compare_sources` while `whoop`'s value is unaffected.
- `test/edits-metric-column.test.ts` (new file) — full MCP round-trip loop, mirroring
  `tools-granular-e2e.test.ts`'s shape: `propose_edit(ro)` → `confirm_edit(rw)` → hidden on **both**
  `compare_sources` and `health_snapshot` → `undo_edit(rw)` → restored on both. Second test confirms
  `propose_edit` returns `target_not_found` for a column with no value.

**Commit:** `d8eb8fc` — `fix(delete_metric_point): allow targeting a dailyMetric column directly`

## Fix 3 — key/column discoverability

**Problem:** Nothing listed valid dailyMetric column names or metricSeries key names, which is what
caused the audit to waste a whole agent-run failing to find `skinTempDevC`.

**Fix:**
- `src/mirror.ts` — two new `Mirror` methods:
  - `dailyMetricColumns()`: `PRAGMA table_info(dailyMetric)`, filtered to exclude the `deviceId`/`day`
    identity columns.
  - `metricSeriesKeyCounts(limit = 100)`: `SELECT DISTINCT key ... LIMIT 100` first, then a single
    grouped `COUNT(*)` query restricted to those keys (not a full-table aggregate), returning
    per-family counts (`{key, counts: {whoop?, oura?, apple?}}`).
- `src/tools/core.ts` — `dataFreshness()` now returns `dailyMetricColumns` and `metricSeriesKeys` in
  both the normal and `notIngested` response shapes.
- `src/tools/compare.ts` and `src/tools/query.ts` — `compare_sources` and `metric_series` tool
  descriptions now name the common columns/keys explicitly (`restingHr, avgHrv, spo2Pct, steps,
  totalSleepMin, efficiency, skinTempDevC, recovery, strain`; `oura_*/ref_*` scores; `body_age,
  fitness_age, sleep_performance, steps_est, vitality`) and point back at `data_freshness` for the
  full lists.
- `src/tools/core.ts` — `data_freshness`'s own tool description now mentions both new fields.

**Files changed:** `src/mirror.ts`, `src/tools/core.ts`, `src/tools/compare.ts`, `src/tools/query.ts`

**Tests added:**
- `test/tools-core.test.ts` — `data_freshness` returns both lists non-empty on the fixture mirror,
  `dailyMetricColumns` contains `skinTempDevC` (the exact motivating gap) and `restingHr`, excludes
  `deviceId`/`day`; `metricSeriesKeys` contains `vo2max` with non-zero `apple`/`whoop` counts.

**Commit:** `8d4e863` — `feat(data_freshness): surface dailyMetric columns + metricSeries keys`

## Fix 4 — data_freshness sources list hides raw-sample-only devices

**Problem:** `Mirror.sources()` derived its device list from `dailyMetric` alone, so a strap deviceId
that only ever writes raw `hrSample`/`stepSample` rows (its scored rollups landing under a separate
derived `-noop` deviceId, e.g. real production's `"my-whoop"` vs `"my-whoop-noop"`) was invisible even
though it holds real data.

**Fix:** `src/mirror.ts` — `sources()` rewritten to union deviceIds across `dailyMetric`,
`sleepSession`, and `hrSample`: one cheap `GROUP BY deviceId` aggregate query per table (each keyed
off that table's own deviceId-prefixed primary key — `MAX(day)` / `MAX(date(startTs,'unixepoch'))` /
`MAX(date(ts,'unixepoch'))`), merged in JS. Each source now carries a `tables: string[]` field
listing which of the three tables it appears in, plus `latestDay` taken as the max across all three.
`src/tools/core.ts` — `dataFreshness()`'s `sources` mapping and tool description now surface `tables`.

**Files changed:** `src/mirror.ts`, `src/tools/core.ts`

**Tests added:**
- `test/mirror.test.ts` — new test: seeds an isolated `hrSample` row for a synthetic device
  (`strap-raw-only`, no dailyMetric/sleepSession rows at all) directly into the file-scoped fixture
  mirror after `buildMirrorSqlite`, then asserts `Mirror.sources()` surfaces it with `tables:
  ["hrSample"]` and the correct `latestDay`; also checks a dailyMetric-only device (`oura-api`)
  reports `tables` containing both `dailyMetric` and `hrSample`.
- `test/tools-core.test.ts` — `data_freshness`'s `sources` entries carry `tables`.

**Commit:** `51532e1` — `fix(data_freshness): surface devices that only ever write raw samples`

## Test suite result

99 original tests + 10 new tests = **109/109 passing**. Full suite re-run after every commit stage
during the incremental rebuild (each fix was rebuilt from a clean checkout and committed separately,
verifying tests green and `tsc --noEmit` clean at every stage — not just at the end).

```
Test Files  24 passed (24)
     Tests  109 passed (109)
```

`npx tsc -p tsconfig.json --noEmit` and `npm run build` both clean (strict mode).

## Commits (conventional, no Claude attribution)

| Commit | Message |
|---|---|
| `f62cec1d014c3d2335f4cddfa5a0208f379f3cab` | fix(compare_sources): include days whose only evidence is a metricSeries fallback row |
| `d8eb8fce20343f93e1b5fa543cd9f80ea0dfa0b9` | fix(delete_metric_point): allow targeting a dailyMetric column directly |
| `8d4e8634cf669c2163f010376ed3e236c5721192` | feat(data_freshness): surface dailyMetric columns + metricSeries keys |
| `51532e18f04e059687f98934c30b807289cedb2f` | fix(data_freshness): surface devices that only ever write raw samples |

## Deploy status

`fly deploy` succeeded (image `vk-noop-cloud:deployment-01KXD63JCTC3T6PPACZP6AG726`, 85 MB).
`fly logs --no-tail` shows a clean boot sequence (filesystem check, volume mount, `noop-cloud on
:8080`, health check passing) with no errors or exceptions. Live-verified:

```
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" https://vk-noop-cloud.fly.dev/healthz
{"ok":true}
HTTP_STATUS:200

$ fly status
Machines
 PROCESS  ID              VERSION  REGION  STATE    CHECKS
 app      7811d19db5d998  12       iad     started  1 total, 1 passing
```

**Fix 3 could not be live-verified via curl** — `data_freshness` is an MCP tool, not an HTTP
endpoint, and the MCP protocol isn't curl-friendly for ad hoc verification. Confidence instead comes
from: the dedicated `dataFreshness()` unit tests (which exercise the exact same code path the MCP
tool calls), the clean typecheck/build, and the clean production boot log confirming the deployed
process starts without error. This is a documented limitation, not a skipped step.

## What was not done / limitations

- Phone-side (NOOP iOS app) support for applying dailyMetric-column deletes during Phase-3 sync was
  explicitly out of scope and not touched — the task confirmed this is expected (the phone surfaces
  `needsAttention` and acks without applying). Only the server-side propose/confirm/overlay/read path
  was built.
- No README changes — the task's scope was the four fixes plus this report; `README.md`'s "Editing
  your data" section wasn't updated to describe the new dailyMetric-column capability of
  `delete_metric_point`. Worth a follow-up doc pass if the maintainer wants it documented there too.
