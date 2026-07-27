# Delta sync for noop-cloud — design + implementation plan

Status: **design only, nothing built.** Written 2026-07-26 against `noop-cloud@harden/storage-guardrails`
(streaming-ingest work in the working tree, uncommitted) and `noop-wt-integrate@capture-deep`.

Audience: whoever implements this. Assumes you have read `src/ingest.ts`, `src/zipstream.ts`,
`src/mirror.ts`, and `Strand/CloudSync/CloudSyncModel.swift`.

---

## 0. Recommendation, up front

**Three things, in this order.**

1. **Today, no code: `fly volumes extend noop_data -s 10`.** The streaming fix removed the *memory*
   ceiling entirely (peak RSS is now O(1), ~100 MB). What remains is a *disk* ceiling at ~1.16 GB of
   database, which at VK's measured growth rate of **~8.3 MB/day** arrives in **~8 weeks** (late
   September 2026). A 3 GB → 10 GB volume costs roughly $1/month and pushes that out past 2028. Buying
   the deadline away for a dollar is strictly better than building a protocol under time pressure.

2. **Then fix the phone's error handling — not delta sync.** `CloudSyncClient` collapses *every*
   non-2xx into `badResponse(status, prefix)`. The server carefully distinguishes 413 (`too_large`,
   discard) from 507 (`insufficient_space`, *keep the backup and retry later*), and the phone throws
   away that distinction. There is **no retry, no backoff**, and the next attempt is 4–20 hours later.
   The 10-day outage was one 502 followed by a 4-hour-cadence retry loop against a server that OOMed
   every time. This is ~150 lines of Swift and it is the single highest value-per-line change available.

3. **Then build delta sync — for latency and reliability, not for disk.** The reason to do this is
   *not* that 608 MB is big. It is that a 200 MB upload preceded by two full-database page scans
   (`wal_checkpoint(TRUNCATE)` + `PRAGMA quick_check(1)`) and a full deflate **structurally cannot
   complete inside a `BGAppRefreshTask` budget (~30 s)**, and `URLSession.shared` has no background
   configuration, so nothing survives app suspension mid-transfer. Delta sync turns a sync into a
   ~400 KB, ~2-second operation that can run on **every** background wake instead of every 4–20 hours.
   That is the actual product win. The bytes are a side effect.

**The design: tiered, partition-reconciling sync.** Two mechanisms, one wire format:

- an **`append`** fast path — for the 13 append-only per-second stream tables (99.8% of all rows),
  ship rows with `ts > server_watermark`, apply as upsert;
- a **`replace`** repair path — for a `(table, deviceId, day)` partition or a whole small table, ship
  the full contents, apply as `DELETE partition; INSERT rows` in one transaction.

`append` is an optimization. `replace` is the invariant that makes it safe. Mutations, deletes,
re-keyed sleep sessions, `TimestampHeal`'s untombstoned range deletes, drift, bootstrap, and resume
after a half-applied batch are **all the same mechanism**, so there is no separate reconcile subsystem
to build and no drift can outlive one sync of the affected partition.

**Required phone migrations: zero.** Watermarks are server-authoritative and fetched per sync;
digests are computed on the fly; no `rowVersion` column, no change-journal table, no triggers.
This matters more than it sounds — see §9.

**Cheaper 80% option?** Yes, and it is *inside* this design rather than an alternative to it: ship
Stage 3 (`append` fast path) and keep the existing full `/ingest` as a monthly correctness backstop.
That is ~95% of the win for ~30% of the work, and Stage 4 (`replace` reconcile) later retires the
monthly full upload. **Build Stage 3 first. Do not build mutation tracking. Ever.**

---

## 1. Assessment of the streaming fix as landed

Read from the working tree at `src/ingest.ts`, `src/server.ts`, `src/zipstream.ts` (untracked),
`src/storage.ts`, `src/config.ts`, `fly.toml`. All uncommitted on `harden/storage-guardrails`.

### What it actually did

`express.raw()` is gone from `/ingest`. The request body streams to `.staged-<hex>.noopbak` on the
volume (`receiveUploadBody`, enforcing `maxIngestBytes` as bytes arrive, pausing rather than
destroying the request so the 413 can actually be written). `src/zipstream.ts` is a hand-rolled ZIP
reader that parses the central directory from the file (correctly preferring it over local file
headers, and handling ZIP64) and inflates the entry through a 64 KB `pipeline` straight to the staged
path. `GuardStream` enforces the decompressed ceiling and the SQLite magic **as output is produced**,
so a zip bomb or a garbage payload costs 64 KB instead of a gigabyte. `adm-zip` is no longer on the
`/ingest` path (it remains a dependency for test fixtures only).

The atomic swap is preserved unchanged. Two disk preflights were added (`requireSpaceFor`): one for
the compressed body before the transfer is accepted, one for the staged copy before inflation — the
second measured *after* the body is on disk, so it correctly accounts for the first. The compressed
body is released (`closeFd` + `rmSync`) immediately after inflation, before validation, which is the
right place. `sweepStagedArtifacts` runs at construction and before every ingest, with a 1-hour age
guard so it cannot race a live upload.

### Peak RAM: ceiling removed, and it is genuinely O(1)

| | before | after |
|---|---|---|
| body buffer | ~200 MB (`express.raw`) | 64 KB stream chunks |
| `entry.getData()` | ~608 MB | 0 — inflated to disk |
| `Buffer.concat` / inflate transients | several hundred MB | 32 KB zlib window |
| central directory | n/a | ~200 B (bounded at 8 MB) |
| `quick_check` page cache | — | better-sqlite3 default, ~2 MB |
| **measured / expected peak RSS** | **1.3–1.5 GB** | **~100–120 MB, flat in DB size** |

This is a real fix, not a bigger bucket. Nothing on the path is proportional to the database. The
previous two "fixes" were RAM doublings (512 MB → 1 GB → 2 GB), each buying only the weeks it took the
database to grow into it; this one has no such term.

### Peak DISK, and the real ceiling

Measured today via `GET /status` (through `data_freshness`):

```
volume total (statfs)   3,134,808,064 B
free                    2,444,197,888 B
mirror                    534,204,416 B   (2026-07-18)
server.sqlite               1,495,040 B
→ available on an empty volume ≈ 2,979,897,344 B
MIN_FREE_BYTES            268,435,456 B
MAX_INGEST_BYTES        1,073,741,824 B   (1 GiB, config.ts and fly.toml now agree)
```

During an ingest the volume transiently holds **body + staged copy + live mirror**. With `U` = the
uncompressed database and the measured SQLite-in-zip ratio of ~3× (608 MB → ~200 MB):

```
A − U − U/3 − S  ≥  U + MIN_FREE
2,979,897,344 − 1,495,040 − 268,435,456  ≥  2.333·U
U ≤ ~1,161,000,000 B  ≈  1.16 GB
```

**Peak disk today** (534 MB mirror, 608 MB upload): 534 + ~200 + 608 ≈ **1.34 GB** of 2.98 GB. Fine.

**So: is the preflight correct?** Yes, and notably it is *conservative in the right direction* —
`diskUsage` uses `bavail` (excludes ext4 root-reserved), and the configured 1 GiB ceiling sits ~7%
**below** the computed 1.16 GB disk ceiling. That ordering is correct: the phone gets a clean 413
("this upload is too big, full stop") before it can ever get an ambiguous 507. Two residual notes:

- The ceiling assumes `mirror ≈ new upload`. True in steady state. If the mirror were ever much
  *larger* than an incoming upload (a restore from an old backup) there is more headroom, not less.
- `fs.renameSync` unlinks the old mirror inode. A long-running MCP read holding that inode keeps its
  blocks allocated until it closes. With per-call `new Mirror()` opens and sub-second reads this is
  negligible, but it means free space can briefly lag a swap by one mirror-size. The preflight already
  reserves that much, so it is a note, not a bug.

### Is it a sufficient stopgap, and for how long?

**Yes, and for about 8 weeks — but the binding constraint is time, not bytes.**

Growth, measured: mirror 534,204,416 B at 2026-07-18; phone database ~608 MB at 2026-07-26.
**≈ 8.3 MB/day.** Not linear — it steps up whenever a new per-second stream lands (`sleepStateSample`
began 2026-07-11 and is already 615k rows; `ppgWaveformSample` began 2026-07-15).

| ceiling | value | days at 8.3 MB/day | date |
|---|---|---|---|
| `MAX_INGEST_BYTES` | 1.074 GB | ~56 | ~2026-09-20 |
| disk (computed) | ~1.16 GB | ~67 | ~2026-10-01 |
| 10 GB volume | ~3.9 GB | ~400 | ~2027-09 |

**The time budget is worse than the byte budget, and the streaming fix does not touch it.** One
sync today costs, on the phone: `wal_checkpoint(TRUNCATE)` + `PRAGMA quick_check(1)` (a full page scan
of 608 MB) + deflate of 608 MB → ~200 MB; then on the server: inflate 608 MB + a *second* full
`quick_check`. Plus the transfer. On LTE at ~3 MB/s that is 60–70 s of network alone; end to end,
plausibly 90–150 s. `BGAppRefreshTask` gives ~30 s. `URLSession.shared` has no background
configuration, so a suspension mid-transfer loses everything. **The whole-DB path cannot reliably
complete on background refresh by construction** — it works when VK opens the app and it is on Wi-Fi,
and that is the actual sync cadence today.

That is why the recommendation is "extend the volume, then build deltas for latency". Extending the
volume removes the only deadline; nothing else about the whole-DB path gets better with time.

---

## 2. What is actually in the 534 MB

From `streams` (live, 2026-07-26) and `Packages/WhoopStore/Sources/WhoopStore/Database.swift`
(31 migrations, latest `v29-daily-avg-sdnn`). **Every** `ts`/`startTs`/`endTs` is unix epoch
**seconds**; every `day` is `"YYYY-MM-DD"` TEXT.

### Tier A — append-only per-second streams (13 tables, 7,905,443 rows ≈ 99.8%)

| table | primary key | rows | span |
|---|---|---|---|
| `hrSample` | `(deviceId, ts)` | 2,360,998 | 2024-06-03 → |
| `gravitySample` | `(deviceId, ts)` | 1,421,476 | 2026-06-26 → |
| `skinTempSample` | `(deviceId, ts)` | 1,421,476 | 2026-06-26 → |
| `stepSample` | `(deviceId, ts)` | 1,421,476 | 2026-06-26 → |
| `sleepStateSample` | `(deviceId, ts)` | 615,159 | 2026-07-11 → |
| `rrInterval` | `(deviceId, ts, rrMs, seq)` | 614,603 | 2026-06-26 → |
| `ppgHrSample` | `(deviceId, ts)` | 23,223 | |
| `event` | `(deviceId, ts, kind)` | 15,249 | |
| `ppgWaveformSample` | `(deviceId, ts)` | 9,114 | `samples BLOB`, ~50 B/row |
| `appleStepHour` | `(deviceId, ts)` | 1,447 | `ts` = hour bucket |
| `battery` | `(deviceId, ts)` | 1,222 | |
| `respSample` | `(deviceId, ts)` | 0 | never captured |
| `spo2Sample` | `(deviceId, ts)` | 0 | not emitted by 5/MG |

Three tables at *exactly* 1,421,476 rows each is the per-second capture triple — roughly **65k
rows/day each**, ~195k rows/day combined, plus `sleepStateSample` at ~88k/day and `rrInterval` at
~28k/day. Call it **~350k rows/day**, which is where the 8.3 MB/day comes from.

### Tier B — small, mutable, rewritten wholesale (16 tables, ~14,076 rows ≈ 0.2%)

`metricSeries` (11,580, PK `(deviceId, day, key)`), `ouraRaw` (944, PK `(deviceId, endpoint,
documentId)`, verbatim JSON payloads), `sleepSession` (618, PK `(deviceId, startTs)`), `dailyMetric`
(565, PK `(deviceId, day)`), `workout` (257, PK `(deviceId, startTs, sport)`), `appleDaily` (52),
`grdb_migrations` (32), `cursors` (18, no `deviceId`), `phoneTimezone` (4, no `deviceId`),
`cloudTombstone` (3), `pairedDevice` (2, PK `id`), `device` (1, PK `id`), and the currently-empty
`journal`, `labMarker`, `liveSession`, `dayOwnership`.

### Excluded

`rawBatch` — transient BLE frame outbox, `framesBlob BLOB`, soft-capped ~50 MB on the phone and
actively evicted by `PrunePolicy`. **0 rows in the mirror**, no MCP reader needs it. It is both waste
(up to 50 MB per full upload) and actively hostile to a delta protocol: rows appear and are evicted,
producing a partition mismatch that can never converge. See open question **Q6**.

### The one-line conclusion

**~99.8% of the rows and ~95% of the bytes live in 13 append-only, `(deviceId, ts)`-keyed tables.
Everything mutable is small enough to ship in full, forever.** That asymmetry is what makes this
tractable, and it is why the design does not need row-level change tracking.

---

## 3. Why not `rowVersion` / a change journal / `data_version`

The brief asks for each option's schema cost. All three are **rejected**, and one reason applies to
all of them:

> `Packages/WhoopStore/` is **upstream-shared code** and is **not** `CLOUD_SYNC`-gated. `Database.swift`
> ships in every build including upstream's. `CLAUDE.md`: *"Analytics and stored data must be
> byte-identical across Swift and Kotlin. If you change a … migration, or a stored value on one
> platform, change the twin on the other in the same PR."* And upstream's charter forbids cloud sync
> outright. **A migration whose only justification is "so my private cloud can do delta sync" cannot be
> written.** (`v26-cloud-tombstone` is precedent that store-layer schema *can* land — but it pays for
> itself as a general resurrection guard, not as transport bookkeeping.)

| option | schema cost | verdict |
|---|---|---|
| `updatedAt`/`rowVersion` column | a new column + index on 13–29 tables; every INSERT/UPDATE site in `StreamStore`, `MetricsCache`, `JournalWorkoutAppleCache`, `MetricSeriesStore`, `LabMarkerStore`, `TimestampHeal` must set it; a Room twin for each | **Reject.** Largest possible blast radius in shared code, permanent upstream merge conflicts, and it *still* cannot express a delete. |
| change-journal table + triggers | one new table + a trigger per tracked table, in the shared migrator | **Reject.** Same upstream problem, plus a trigger firing on a 350k-row/day insert path. |
| `PRAGMA data_version` | none | **Reject for this purpose.** It reports *that* another connection wrote, never *what*. Useful as a "has anything changed at all" gate; useless for row-level deltas. |
| **watermark on the natural key + partition replace** | **none** | **Adopt.** Every table already has the key it needs. Watermarks live server-side. Digests are computed on demand. |

There is also a decisive empirical argument against change tracking, from the schema survey:

- `MetricsCache.upsertDailyMetrics` rewrites **all 19 non-key columns on every recompute**;
  `upsertSleepSessions` rewrites six; `JournalWorkoutAppleCache.upsertWorkouts` rewrites ten.
  **Row-level dirty tracking would mark essentially every derived row dirty on every sync** — it would
  produce a delta the size of Tier B while costing a migration on every table.
- `IntelligenceEngine` (`Strand/Data/IntelligenceEngine.swift:1400`) **deletes a sleep session by PK
  and reinserts it under a different `startTs`** during dedup. Sleep sessions have no stable identity
  across recomputes, so "which row changed" is not even a well-posed question.

Ship Tier B in full. It is 14,076 rows.

---

## 4. The protocol

### 4.1 Operations — two, and the second subsumes the first

```
append   (table, deviceId, rows)                 rows with ts > watermark; applied as upsert; never deletes
replace  (table, deviceId, partition, rows)      full contents of the partition; applied as DELETE-then-INSERT
```

`partition` is a UTC day (`"2026-07-18"`) for Tier A, and the sentinel `"*"` (whole table) for Tier B.

`replace` alone is sufficient and correct for everything. `append` exists purely because re-shipping
today's whole partition on every wake would cost ~2 MB instead of ~50 KB. **Treat `append` as a cache
and `replace` as the truth**; every correctness argument below rests on `replace`.

What this buys, all from one mechanism:

| problem | how `replace` handles it |
|---|---|
| mutation of an old row | partition digest differs → partition replaced |
| delete with no tombstone (`TimestampHeal`'s 12 unscoped range `DELETE`s) | fewer rows → digest differs → partition replaced → rows disappear |
| sleep session re-keyed to a new `startTs` | whole `sleepSession` table is one partition → replaced |
| `dailyMetric`'s window-wide `deleteDailyMetrics(from,to)` (#277 re-bucketing) | same |
| drift from an accumulated delta error | digests disagree → partitions replaced |
| a batch that half-applies | the next sync's digest comparison re-emits exactly the partitions that did not land |
| bootstrap / months offline | server has no partitions → all differ → ship them all, chunked and resumable |

### 4.2 Watermarks — server-authoritative, always

The server's watermark for `(table, deviceId)` is **`MAX(ts)` of what the mirror actually holds**,
computed from the mirror, never stored as phone-asserted state. The phone fetches it before every
batch and caches it only as a hint.

This is the most important decision in the protocol. If the phone held the authoritative watermark, a
server restored from a backup would silently have a permanent hole: the phone believes those rows are
delivered and never re-ships them. Server-authoritative means a server rollback simply rewinds the
watermark and the phone re-ships. Cost: one small `GET` per sync.

Advancement is monotonic: `watermark = MAX(existing, batch_max)`, never assignment. A late-arriving
out-of-order batch re-inserts rows the mirror already has (a no-op upsert) and cannot rewind.

**Known trap, must be handled:** `TimestampHeal.healImplausibleTimestamps` runs
`DELETE FROM <t> WHERE ts < ? OR ts > ?` across 10 stream tables. If a bogus far-future row (say
`ts` in 2050) is uploaded and *then* healed away on the phone, the server's `MAX(ts)` watermark sticks
at 2050 and the `append` fast path ships nothing, forever, silently. Three defences, use all three:

1. The phone computes its ship-range as `ts > MIN(server_watermark, now + 86400)` — a bogus future
   watermark degrades to "ship the last day", not "ship nothing".
2. `POST /ingest-delta` rejects any row with `ts > now + 86400` (400 `implausible_ts`), so the bogus
   row never enters the mirror.
3. The Stage-4 reconcile compares partition counts and would surface it regardless.

### 4.3 Partition digests

For Tier A, the digest of `(table, deviceId, day)` is **`COUNT(*)`**. That is sufficient: the only
per-row mutation on any Tier-A table is the `synced` column, which `StreamStore.swift:62` documents as
**dead** — never written, never read, and not selected by any `mirror.ts` query. Counts catch inserts
and deletes, which are the only things that happen.

```sql
SELECT deviceId, ts/86400 AS dayIndex, COUNT(*) AS n
FROM hrSample GROUP BY deviceId, dayIndex
```
Index-friendly on the `(deviceId, ts)` primary key. ~500 days × 13 tables × ~4 devices ≈ 6,500
integers ≈ 60 KB JSON, ~15 KB compressed.

For Tier B, the whole table is one partition and the digest is `COUNT(*)` plus a modular checksum over
the value columns, e.g. for `sleepSession`:
```sql
SELECT COUNT(*),
       SUM(startTs % 2147483647) % 2147483647,
       SUM(endTs   % 2147483647) % 2147483647,
       SUM(COALESCE(LENGTH(stagesJSON),0)) % 2147483647,
       SUM(userEdited)
FROM sleepSession
```

**Both sides run SQLite**, so a digest expressed as pure SQL is identical by construction — there is
no cross-platform hash to agree on, and `CLAUDE.md`'s FNV-1a-over-UTF-16 rule does not apply because
nothing is hashed in application code. Keep it that way: **never move a digest into Swift/TS.**

These are collision-tolerant checksums, not cryptographic ones. A collision means one missed repair,
healed by the next reconcile. Say so in the code comment; do not pretend otherwise.

### 4.4 Wire format — a `.noopbak`-shaped partial database

**Container: a zip with one entry named `noop-delta.sqlite`.** Deliberately a different entry name
from `noop-backup.sqlite`, so a delta can never be ingested as a full backup or vice versa — the
server matches on the name, and the mismatch is a clean 400.

**Payload: a SQLite database.** Not JSON, not CBOR, not a columnar packing. The reasoning:

- The phone builds it with `ATTACH` + `INSERT … SELECT` — a dozen lines of SQL through the GRDB
  connection it already has. No serializer, no Swift struct that can drift from the schema.
- The server merges it with `ATTACH` + `INSERT … SELECT` — set-based inside SQLite, never marshalled
  through JS. This is the difference between a 2-second merge and a 60-second one.
- It is **column-name driven**, so an additive phone migration does not break the wire format.
- The phone's existing ZIPFoundation writer and `URLSession.upload(for:fromFile:)` are reused
  verbatim; the server's existing `readCentralDirectory` / `extractEntryToFile` / `GuardStream`
  (magic + size ceiling) are reused verbatim. **The transport is already written.**

Cost: SQLite's 4 KB page granularity means a floor of ~100 KB for a delta touching many tables. Against
a 200 MB baseline this is irrelevant. Revisit only if Stage 5 makes batches truly chatty.

**Contents of `noop-delta.sqlite`:**

```sql
CREATE TABLE _delta_meta (k TEXT PRIMARY KEY, v TEXT);
--   protocol=1 | batchId=<uuid> | installId=<uuid> | builtAt=<epoch>
--   basis=<the sync-state etag the phone planned against>
CREATE TABLE _delta_op (
  tbl TEXT NOT NULL, deviceId TEXT, op TEXT NOT NULL,   -- 'append' | 'replace'
  partition TEXT,                                       -- 'YYYY-MM-DD' | '*' | NULL for append
  rows INTEGER NOT NULL,
  PRIMARY KEY (tbl, deviceId, partition));
CREATE TABLE _delta_schema (identifier TEXT PRIMARY KEY, ord INTEGER NOT NULL);
--   the phone's grdb_migrations in registration order
-- …then one table per payload table, SAME NAME and SAME COLUMN NAMES as the mirror,
--    holding only the rows this batch carries.
```

`_delta_schema` carries the **ordered** `grdb_migrations` identifier list, not a version number.
Migration identifiers are **not ordinal** — `v26` and `v27` each appear twice and `v26-efficiency-heal`
registers *after* `v27-apple-step-hour`. And `WhoopStoreInfo.schemaVersion` is stale at 18 against 31
migrations and is pinned there by a test assertion. **Never parse a number out of a migration id.**

### 4.5 Endpoints

**`GET /sync-state`** — scope `rw` (it reveals data shape). Cheap, called before every batch.

```jsonc
{
  "protocol": 1,
  "bootstrapRequired": false,          // true when there is no mirror at all
  "etag": "…",                          // opaque; echo back as _delta_meta.basis
  "schema": ["v1", …, "v29-daily-avg-sdnn"],
  "maxDeltaBytes": 33554432,
  "tables": {
    "hrSample": { "tier": "A", "byDevice": { "my-whoop": { "maxTs": 1784…, "rows": 2103… } } },
    "sleepSession": { "tier": "B", "digest": [618, 1234…, 5678…, 91011, 3] }
  }
}
```

**`GET /sync-state?partitions=1`** — the same, plus the per-`(table, deviceId, day)` count map. Only
the Stage-4 cold path calls this. Kept as a separate parameter so the hot path stays a few hundred bytes.

**`POST /ingest-delta`** — scope `rw`.

| header | value |
|---|---|
| `Content-Type` | `application/octet-stream` |
| `X-Delta-Protocol` | `1` |
| `X-Delta-Batch-Id` | uuid — idempotency + logging |
| `X-Phone-Timezone` | as `/ingest` today |

Response echoes the **fresh** `/sync-state` so the phone can chain batches without a second round trip
(the `POST /deepbuf` receipt already sets this precedent):

```jsonc
{ "ok": true, "batchId": "…", "duplicate": false,
  "applied": { "hrSample": { "inserted": 41022, "partitionsReplaced": 0 } },
  "syncState": { /* as above */ } }
```

Status codes, and they must all be distinguishable on the phone:

| code | error | phone must |
|---|---|---|
| 409 | `bootstrap_required` | fall back to full `POST /ingest`, then resume deltas |
| 409 | `merge_in_progress` | retry with jitter |
| 400 | `bad_delta`, `corrupt_sqlite`, `implausible_ts` | discard the batch, log, do **not** loop |
| 413 | `too_large` | rebuild with a smaller chunk cap |
| 507 | `insufficient_space`, `storage_unavailable` | **keep the batch, back off, retry later** |

`maxDeltaBytes` defaults to **32 MB compressed** — three orders of magnitude below `maxIngestBytes`,
because a delta has no legitimate reason to approach it. Bootstrap ships many bounded batches, not one
enormous one.

**`/ingest` is never removed.** It remains the bootstrap, the disaster-recovery path, the
schema-change path, and the escape hatch the phone falls back to whenever anything is ambiguous.

### 4.6 Server-side merge

The single most important property of the current server is one many designs would casually break:

> **The mirror is never written by the server.** All 19 call sites do
> `new Mirror(path)` → `new Database(path, { readonly: true, fileMustExist: true })`. Confirmed edits
> live in `server.sqlite`'s `editJournal` and are applied as a **read-time overlay**
> (`src/edits/overlay.ts`). The atomic swap is the *only* thing that has ever mutated the mirror.

Merging makes the server a mirror writer for the first time. **Do it without giving that up:**

```
 1  validate zip; require exactly the entry `noop-delta.sqlite`; SQLite magic; ≤ maxDeltaBytes
 2  inflate to .staged-<hex>.sqlite            (reuse extractEntryToFile + GuardStream verbatim)
 3  open staged readonly; quick_check; require _delta_meta.protocol == 1
 4  if _delta_schema != the recorded mirror schema  → 409 bootstrap_required          (see §4.7)
 5  if batchId already in deltaLog             → return { duplicate: true } and stop   (see §4.8)
 6  requireSpaceFor(mirrorBytes + deltaBytes, cfg, "merge copy")
 7  fs.copyFileSync(mirror → .staged-<hex>.merge.sqlite)
 8  open the copy read-write; ATTACH the staged delta AS d; BEGIN IMMEDIATE
      for each _delta_op:
        reconcile schema additively                                                    (see §4.7)
        cols = intersect(PRAGMA table_info(main.T), PRAGMA table_info(d.T))
        replace:  DELETE FROM main.T WHERE <partition predicate>;
                  INSERT INTO main.T (cols) SELECT cols FROM d.T <partition predicate> ORDER BY <pk>;
        append:   INSERT INTO main.T (cols) SELECT cols FROM d.T ORDER BY <pk>
                    ON CONFLICT (<pk>) DO UPDATE SET <non-pk cols> = excluded.<col>;
    COMMIT
 9  PRAGMA wal_checkpoint(TRUNCATE); close
10  remove mirror's stale -wal/-shm; fs.renameSync(merged → mirror)                    ← unchanged swap
11  record deltaLog row; log applied counts
```

**Transactionality is free, and a half-applied batch is impossible.** The merge happens in a
throwaway copy. Any failure — a `ZipError`, an `ENOSPC`, a SQLite fault, a SIGKILL — deletes the copy
(or leaves it for `sweepStagedArtifacts`, whose `.staged-*` regex already covers it) and **the live
mirror is bit-identical to what it was**. There is no partial state to reason about, and the existing
"does not corrupt an existing mirror when the upload is invalid" test in `test/ingest.test.ts` extends
directly.

**Peak disk is *lower* than today:** `2 × mirror + delta + WAL ≈ 1.07 GB + ~50 MB` versus the whole-DB
path's ~1.34 GB. `requireSpaceFor` is reused unchanged.

**Cost: a 534 MB file copy per merge.** At 8 syncs/day that is ~4.3 GB/day of volume writes to move
~4 MB of data — a ~1000× write amplification. Fly's NVMe volumes absorb this without complaint and the
copy takes ~1–3 s, but it is the one number that would justify moving to an in-place WAL merge later
(§7, Stage 5). It is deliberately accepted for Stage 2 because it buys an unchanged read path.

**Two SQL details that are not optional:**

- Use `ON CONFLICT … DO UPDATE`, **not `INSERT OR REPLACE`**. `REPLACE` deletes and re-inserts, which
  assigns a **new rowid**. `Mirror.rrIntervalsRange` orders by `ts, rowid` on purpose — same-second
  beats are common at resting HR, and ordering them by value provably breaks RMSSD (there is a test
  for it: an 800/850 ms alternating series loses its ±50 ms successive diff). A `REPLACE` would silently
  reorder beats and corrupt HRV. `DO UPDATE` preserves rowid. **Also: `rrInterval` has a real `seq`
  column (`v24-rr-seq`, part of the 4-column PK) — before Stage 3 ships, change
  `rrIntervalsRange` to `ORDER BY ts, seq` and delete the rowid dependency entirely.** Do this as a
  standalone commit with a test, ahead of any merge work.
- `INSERT … SELECT … ORDER BY <pk>` so rowid allocation follows key order, keeping the mirror's
  physical layout close to what a fresh full upload would produce.

### 4.7 Schema evolution — the problem the swap used to hide

With whole-DB replacement, a phone migration propagated for free. **With merging it does not.**
Two rules:

1. **Additive changes are reconciled inline.** A table present in the delta but not the mirror →
   `CREATE TABLE` from `d.sqlite_master`. A column present in the delta but not the mirror →
   `ALTER TABLE main.T ADD COLUMN`. A column in the mirror but not the delta → left alone, logged.
   **Never DROP anything.** This mirrors the project's own additive-only migration charter.
2. **Any schema change the server has not seen forces a bootstrap.** If `_delta_schema` is not
   identical to the migration list recorded at the last full ingest → **409 `bootstrap_required`** and
   the phone does one full `/ingest`. Compare the ordered identifier list, never a parsed version.

Rule 2 makes rule 1 belt-and-braces rather than load-bearing, and it is cheap: VK has shipped 31
migrations in the project's life. One extra full upload per migration is free and it eliminates an
entire class of bug (a destructive migration like `v24-rr-seq`'s table rebuild, or
`v26-efficiency-heal`'s `UPDATE … SET efficiency = efficiency/100.0`, which a delta protocol has no way
to express). **Take the conservative rule.**

### 4.8 Idempotency, ordering, retries

- **Idempotent by construction.** Every `append` is a keyed upsert; every `replace` is
  `DELETE partition; INSERT partition`. Applying the same batch twice yields the same mirror. No batch
  bookkeeping is required *for correctness*.
- `batchId` is recorded in a `deltaLog` table in `server.sqlite` and a repeat returns
  `{ duplicate: true }` without re-merging — for observability and to skip a pointless 534 MB copy,
  exactly as `deepBufferChunk`'s `UNIQUE (generation, byteStart)` does today.
- **Out-of-order batches converge**, because watermark advancement is `MAX()` and both operations are
  keyed. A stale batch re-inserts rows that already exist.
- **A lost 2xx is safe**: the phone retries, the server reports `duplicate`, the phone advances. This
  is precisely the at-least-once-onto-an-idempotent-sink contract `DeepBufferUploader` already relies
  on, and its `duplicate: Bool` receipt is counted, not treated as failure.
- **Serialize merges.** Two concurrent merges would race the staged copy and the second would silently
  discard the first. An in-process mutex suffices on one machine (`min_machines_running = 0`,
  `auto_start_machines = true` — Fly can in principle start a second). Take an `O_EXCL` lock file in
  `dataDir` as well; a second merge returns **409 `merge_in_progress`**.

### 4.9 Deletes and tombstones

**Most deletes need no tombstone at all**, which is the design's biggest simplification. `replace`
expresses deletion as absence:

- Tier B is one partition per table, so `sleepSession` deletions, `dailyMetric`'s window-wide
  `deleteDailyMetrics(from,to)`, `workout` range deletes, and `IntelligenceEngine`'s
  delete-and-reinsert-under-a-different-`startTs` dedup are **all handled by replacing the table**.
- Tier A deletions — `TimestampHeal`'s 12 unscoped range `DELETE`s, `CloudEditDeletes.deleteHrRange`,
  `DeviceRegistryStore.deleteAllData` — are handled by **replacing the affected day partitions**,
  found by the Stage-4 count comparison.

**`cloudTombstone` keeps its existing job and is not extended.** It is a *resurrection guard*
(`INSERT OR IGNORE`, unique on `(kind, editSeq)`, consulted by `upsertWorkouts`, `StreamStore.insert`,
and `upsertMetricSeries`), it covers exactly three kinds (`workout`, `hrRange`, `metricPoint`), it has
no `table` column, and it is deliberately exempt from `deleteAllData`. It rides along as an ordinary
Tier-B table so the mirror keeps receiving it as data, exactly as it does today. **Do not try to make
it a general transport tombstone log** — it is not shaped for that, and `replace` makes it unnecessary.

Note the deletes that never reach SQL at all: dismissed sleep and workout spans live in **UserDefaults**
as `"startTs:endTs"` strings (`DismissedSleepSpans.swift`, explicitly *"the app layer must not extend
with a new table"*). They are invisible to any database-level protocol today and remain so. Unchanged
behaviour, worth knowing.

**Latency, honestly stated:** with the `append`-only fast path (Stage 3), a Tier-A delete does not
reach the mirror until the next reconcile (Stage 4, weekly). During that window an MCP tool can return
rows the phone has healed away. For `TimestampHeal`, those rows are by definition implausible
timestamps far outside the query ranges tools actually use, so the practical impact is nil — but it is
a real property of the system and it is why Stage 4 is scheduled, not optional.

### 4.10 First sync, new device, long offline

- **No mirror** → `/sync-state` returns `bootstrapRequired: true` → the phone does a full `/ingest`.
  Unchanged from today.
- **Schema fingerprint mismatch** → 409 `bootstrap_required` → full `/ingest`, then deltas resume.
- **Offline for months.** The `append` fast path naturally produces a huge batch. Two bounds:
  1. **Chunk it**, reusing `DeepBufferUploadPlan`'s shape exactly — `maxChunkBytes` and
     `maxChunksPerRun = 8`, watermark persisted after **each** confirmed 2xx so a kill mid-drain keeps
     progress, and `moreRemaining` surfaced in the status line as "· more queued".
  2. **Size heuristic**: if the estimated total delta exceeds ~40% of a full upload, just do
     `/ingest`. After a six-month gap the delta is *larger* than the snapshot, and the snapshot is one
     round trip. Estimating is cheap: `SELECT COUNT(*) … WHERE ts > watermark` per table.
- **A different install** (restore to a new phone) → `_delta_meta.installId` differs from the recorded
  one → 409 `bootstrap_required`. Deltas from two installs must never be interleaved into one mirror.

---

## 5. Interaction with the MCP tools (read consistency)

**With copy-then-rename, nothing changes, and that is the entire point of choosing it.**

Every tool opens the mirror fresh per call (`new Mirror(cfg.mirrorPath)`, 19 call sites in
`src/tools/`), gets an inode, and reads it. `rename(2)` is atomic; a call that started before the
merge keeps reading the old inode to completion, a call that starts after sees the new one. No tool
can observe a partially merged mirror because a partially merged mirror never appears at `mirrorPath`.
**Zero changes to the read path, zero changes to those 19 call sites.** The edit overlay
(`computeOverlay` from `server.sqlite`) is orthogonal and unaffected.

The one residual, noted in §1: a long read holding an unlinked inode delays block reclamation by up to
one mirror-size. Already covered by `requireSpaceFor`.

**If you later move to an in-place WAL merge (Stage 5), this stops being free.** WAL gives snapshot
isolation *per transaction*, and several tools issue three or four separate `prepare().all()` calls —
a merge landing between them would produce a torn read. That migration therefore requires wrapping
each tool's mirror access in a single `BEGIN DEFERRED … COMMIT`, plus `busy_timeout` on the writer,
plus WAL checkpointing discipline (an uncheckpointed WAL is more disk, on the volume whose fullness
started all this). **That is the real cost of Stage 5, and it is why it is Stage 5 and not Stage 2.**

---

## 6. Tigris — recommendation

`vk-noop-deepbuf` is provisioned and **live**: `deep_buffer_coverage` reports 13 chunks, 59,400
buffers, 210,402,099 raw bytes stored as 46,941,192 (**4.48× compression**), `configured: true`. The
index/payload split (`deepBufferChunk` rows in `server.sqlite`, bytes in the bucket) works and is the
right pattern.

**Recommendation, in priority order:**

1. **Keep deep buffers in Tigris. Do not change anything.** ~9 GB/month of raw archive against a 3 GB
   volume is not a close call, and `makeObjectStore` correctly returns `null` rather than falling back
   to the volume.

2. **Do this next, and it is cheap: archive every full `.noopbak` to Tigris.** Today a full upload is
   transient — the compressed body is deleted the moment it is inflated. If the volume is lost, the
   only copy of the mirror is on VK's phone, and recovering means getting a 200 MB upload to complete.
   Tee the body to the bucket during `/ingest` (the body is already streaming through a file, so this
   is one extra `put` of an object that already exists on disk). At ~200 MB/snapshot and a handful of
   retained snapshots, this is **cents per month**, it makes disaster recovery a server-side restore
   instead of a phone-side upload, and — critically — **it gives the delta chain a trustworthy
   baseline**. Once you are merging rather than replacing, "the last known-good full snapshot" stops
   being a nice-to-have.

3. **Do NOT move the hot mirror or any queryable table to object storage.** The mirror's entire value
   is that it is a local SQLite file 19 synchronous call sites can query in microseconds. Moving part
   of it to S3 means either per-query object fetches (latency, egress, and a rewrite of `mirror.ts`)
   or a Parquet query engine (DuckDB — a large new dependency and a full rewrite of every tool). The
   size problem does not justify that: **deltas do not shrink the mirror at all**, but a 10 GB volume
   holds ~3.5 years of growth for about a dollar a month. Buy the disk.

4. **Cold tiering is a real design, but it is Stage 6 and probably never.** If the mirror ever outgrows
   a 10 GB volume, the right cut is per-second sample tables older than N days → Parquet in Tigris,
   partitioned by `(table, deviceId, day)` — note this is the *same partition key* as §4.3, which is
   not a coincidence and is a good reason to adopt that partitioning now even though the reconcile is
   Stage 4. Manifest in `server.sqlite`, exactly like `deepBufferChunk`. Tools gain a cold path.
   **This is tiering, never deletion** — VK's "never discard raw sensor streams" rule is satisfied by
   moving bytes, not by dropping them, and the rule should be restated in that module's header.

---

## 7. Staged rollout

Each stage is independently shippable, independently testable, and leaves the system working.

### S0 — extend the volume *(ops, one command, do it today)*
`fly volumes extend noop_data -s 10`. Then raise `MAX_INGEST_BYTES` in **both** `src/config.ts` and
`fly.toml` (they diverged once — 250 MB vs 768 MB — and that divergence is exactly what let a 608 MB
database through the size check and into the OOM; the comment in `config.ts` now says so). Removes the
deadline. **Verify with `GET /status`: `nextIngestFits` and the free/total numbers.**

### S0.5 — phone: make failures survivable *(app-side, independent value, no protocol)*
Prerequisite for everything after S3, but worth shipping on its own merits.
- Status-aware errors in `CloudSyncClient`: distinguish 413 / 507 / 5xx / 429 instead of collapsing
  them into `badResponse`. 507 must mean *keep the archive and retry*, which today it does not.
- Retry with backoff + jitter, bounded. Today the only retry is the next 4–20 h scheduled sync.
- Move the upload to a **background `URLSessionConfiguration`** so a suspension mid-transfer does not
  lose a 200 MB body, and consider `BGProcessingTask` (which permits longer, charging-gated runs) for
  the whole-DB path.
- **Fix the live BGTask identifier mismatch.** `project.yml` and `StrandiOS/Resources/Info.plist` have
  uncommitted changes moving `BGTaskSchedulerPermittedIdentifiers` to
  `com.vkchitti.noop.cloudsync.refresh`, but `CloudSyncBackgroundRefresh.bgTaskIdentifier` (and
  `ScheduledDebugExport.bgTaskIdentifier`) still say `com.noopapp.*`. **As the working tree stands the
  background sync lane is dead** — the registration will not match the plist. This is unrelated to
  delta sync and should be fixed regardless; it may well be contributing to the current sync failures.

### S1 — server: `GET /sync-state` ← **the first shippable delta increment**
Server-only, read-only, additive, zero risk to any existing path. ~150 lines + tests.
- Per `(table, deviceId)`: `rows`, `maxTs`. Per Tier-B table: the digest tuple. Schema list from the
  mirror's `grdb_migrations`. `bootstrapRequired` when there is no mirror.
- `?partitions=1` for the per-day count map (used only from S4).
- Cache computed digests in `server.sqlite`, keyed by the mirror's `(mtime, size)`.
- **Immediately useful before any delta exists**: it tells you exactly how large a delta *would* be,
  and it lets you audit the phone's `contentToken` against the mirror's reality — which will surface
  the known hole that an equal-count in-place correction to `workout` or `metricSeries` does not move
  the token, so today's system can silently decline to upload a correction.
- Tests: fixture mirror via `buildMirrorSqlite`; assert counts, `maxTs`, digest stability, and
  `bootstrapRequired` on a missing mirror.

### S2 — server: `POST /ingest-delta` (merge-into-staged-copy + swap)
Server-only. The phone does not use it yet; it is exercised entirely from vitest.
- Extend `test/fixtures/make-fixture.ts` with `buildDelta({ appends, replaces })`.
- Tests that must exist: append is idempotent under replay; replace deletes rows absent from the
  partition; a corrupt/garbage delta leaves the mirror bit-identical (extend the existing
  "does not corrupt an existing mirror" test); a schema mismatch returns 409 `bootstrap_required`; an
  additive new column is `ALTER TABLE`d in; concurrent merges yield 409 `merge_in_progress`;
  `implausible_ts` is rejected; `requireSpaceFor` refuses a merge that will not fit (507).
- **Property test worth the effort:** given a random sequence of appends and replaces applied in
  arbitrary order and with arbitrary duplicates, the merged mirror equals the mirror produced by a
  single full ingest of the equivalent source. That single test retires most of the correctness
  argument in this document.
- Ship the Tigris full-snapshot archive here too (§6.2) — it belongs with the ingest path.

### S3 — phone: the `append` fast path ← **the win lands here**
Behind a `CloudSyncSettings` toggle, **default off**. VK flips it on his own device.
- `GET /sync-state` → build `noop-delta.sqlite` via `ATTACH` + `INSERT … SELECT WHERE ts > watermark`
  → zip (existing ZIPFoundation path) → `POST /ingest-delta` (existing
  `upload(for:fromFile:)`) → on 2xx, chain the next batch from the returned `syncState`.
- Tier B: ship a table in full whenever its digest differs. Skip entirely when it does not — which is
  most syncs.
- **Fall back to full `/ingest`** on 409, on a schema mismatch, on the ~40% size heuristic, and on any
  unrecognised failure. The old path is never removed, so the worst case is today's behaviour.
- Keep `contentToken` exactly as it is, as the cheap outer "anything at all?" gate. It is 5 aggregates
  over 5 tables and it is good at that job; it is simply not a delta planner.
- Correctness backstop until S4: **force a full `/ingest` every 30 days.** This is what makes S3
  shippable without the reconcile, and it is the reason S3-alone is a legitimate stopping point.
- Prerequisite, standalone commit: switch `Mirror.rrIntervalsRange` to `ORDER BY ts, seq` (§4.6).

### S4 — reconcile: partition digests + `replace`
Retires the 30-day full upload and closes the delete/mutation gap.
- Weekly (and on demand via a new `reconcile` MCP tool): `GET /sync-state?partitions=1`, compare
  against the phone's own `GROUP BY deviceId, ts/86400` counts, emit `replace` for every mismatch.
- Amortise: scan 1/7 of history per run so no single background wake pays for a full-table group-by.
- Report the outcome in the sync status line and in `data_freshness`, so silent divergence becomes
  visible divergence.

### S5 — optional: in-place WAL merge, packed wire format
Only if the copy-per-merge write amplification (§4.6) proves to matter. Read §5 first: this stage owns
the read-consistency cost, not S2.

### S6 — deferred: cold tiering to Tigris
Only if the mirror outgrows a 10 GB volume. Probably never.

---

## 8. Cost / benefit, honestly

### The win

| | today | S3 `append`, 8×/day | S3 `append`, 1×/day |
|---|---|---|---|
| rows per sync | ~7.9 M (all of them) | ~45 k | ~350 k |
| body on the wire | **~200 MB** | **~300–500 KB** | **~2–3 MB** |
| phone CPU | checkpoint + full `quick_check` + deflate of 608 MB | one indexed range scan + deflate of ~2 MB | ditto, ~14 MB |
| server work | inflate 608 MB + full `quick_check` | inflate ~2 MB + 534 MB copy + merge | ditto |
| wall clock | ~90–150 s | **~2–5 s** | ~5–10 s |
| fits a `BGAppRefreshTask` (~30 s)? | **no** | **yes** | yes |
| server peak RAM | ~100 MB (already fixed) | ~100 MB | ~100 MB |
| server peak disk | ~1.34 GB | ~1.12 GB | ~1.12 GB |

**~400–600× fewer bytes, and — the part that matters — a sync that fits in the window iOS actually
gives you.** Tier B adds ≤~6 MB raw (≈1 MB compressed) on the syncs where sleep or dailies changed,
and nothing on the syncs where they did not.

**What deltas do not do:** they do not shrink the mirror. It still grows ~8.3 MB/day and still needs a
bigger volume eventually. Do not conflate the two problems.

### The risk — one sentence, and it is the whole risk

**The mirror stops being a byte-identical copy of the phone's database, so every future bug is a silent
divergence instead of a loud failure.** Today a broken upload produces a 4xx/5xx and a visibly stale
`mirrorAgeSeconds`. After S3, a broken *planner* produces a mirror that is quietly missing Tuesday, and
every MCP tool answers confidently from it. That is why S4 is scheduled rather than optional, why S3
carries the 30-day forced full upload, and why the S2 property test is worth its weight.

Secondary risks, all bounded: schema evolution (§4.7, handled by forcing a bootstrap); the
future-timestamp watermark stall (§4.2, three defences); merge concurrency (§4.8, a lock file); write
amplification (§4.6, accepted with a number attached).

### The cheaper options, ranked

1. **Extend the volume** — one command, ~$1/month, removes the disk deadline for ~3.5 years.
   Fixes nothing about latency. **Do it anyway, today.**
2. **S0.5 alone** (status-aware errors + retry + background session) — ~150 lines of Swift, no
   protocol, and it is what would have turned the 10-day outage into a 4-hour one. **Highest
   value-per-line change on the board.**
3. **Trim the snapshot** — measure first. `rawBatch` alone may be up to 50 MB per upload of transient
   outbox the server has zero rows of (see **Q6**), and nothing in the repo has ever run
   `PRAGMA page_count` per table. A `dbstat` breakdown of the mirror is an hour of work and may find
   10–20% of the payload is pure waste. Not a plan; a measurement that could change the plan.
4. **S3 without S4** — the `append` fast path plus a 30-day forced full upload. **~95% of the win for
   ~30% of the work**, and it is a legitimate permanent stopping point if VK never wants to build the
   reconcile.
5. **The full design.** Worth it if sync-on-every-wake is the goal.

**Recommended path: 1 → 2 → S1 → S2 → S3, then decide about S4 with real numbers in hand.**

---

## 9. Constraints check

**Swift-only, by design — and there is no Kotlin twin to write.** Android has no cloud sync at all.
All 11 files in `Strand/CloudSync/` open with `#if CLOUD_SYNC`, set only by the untracked, gitignored
`Strand/Oura/OuraSecrets.xcconfig` via `SWIFT_ACTIVE_COMPILATION_CONDITIONS`; a clean checkout builds
with none of this code present. `CLAUDE.md`'s parity rule binds *"analytics and stored data"* — decoders,
formulas, migrations, stored values — because those cross the `.noopbak` boundary and must be
byte-identical. **Delta sync is transport**: it changes no stored value, no decoder, no analytic, and no
migration. State that explicitly in the design header of any new file so the next reader does not
re-litigate it.

**The zero-migration property is load-bearing, not a nice-to-have.** Because watermarks are
server-authoritative, digests are computed on the fly, and Tier B ships in full, **this design needs no
new phone table and no new column.** That matters because:
- `Packages/WhoopStore/` is **not** `CLOUD_SYNC`-gated and ships in upstream builds;
- `CLAUDE.md` requires a Room twin in the same PR for any schema change;
- `DeviceRegistryStoreTests.testDeviceScopedTablesCoversEveryDeviceIdKeyedTable` enumerates
  `sqlite_master` at runtime and **fails if any new `deviceId`-keyed table is added** without being
  registered in `deviceScopedTables`.

Any future change that *does* need phone schema must: register a new migration after
`v29-daily-avg-sdnn`, never edit an existing one, add a `MigrationTests` case proving it applies on top
of the prior version, renumber past upstream's latest at merge time (VK's standing rule), and carry a
Room twin. **Prefer redesigning to avoid it.**

**Fork-only, never upstream.** Upstream's charter is explicit — *"no server, no account, no cloud sync,
no telemetry… hard constraints, not preferences"* — and a PR is out of scope if it *"adds a server,
account, cloud sync, or sends any data off-device."* Everything in this document stays on VK's fork and
in `noop-cloud`. New app-target files carry the standard header (*"A default build contains none of
this code, keeping 'fully offline' a byte-level property of the shipped binary"*). Follow **one concern
per PR**: protocol, schema, and UI stay separate.

**Never discard raw sensor streams.** Nothing here deletes. `append` only adds; `replace` restates a
partition from the phone, which remains the system of record; cold tiering (§6.4) is explicitly
*tiering*, not deletion. The one place this rule needs an actual decision from VK is `rawBatch` —
see **Q6**.

---

## 10. Open questions VK must decide

**Q1 — Extend the volume now?** `fly volumes extend noop_data -s 10`, ~$1/month, removes the disk
deadline for ~3.5 years. Everything in §7 assumes yes. *(Recommendation: yes, today.)*

**Q2 — What is the target sync cadence?** "Every background wake" makes delta sync clearly worth
building. "Once a day when I open the app is fine" makes S0 + S0.5 nearly sufficient and turns delta
sync into a nice-to-have. **This single answer changes the priority of everything below S0.5.**

**Q3 — Is an eventually-consistent mirror acceptable?** Today the mirror is a byte-identical snapshot;
after S3 it is a merged approximation that is *exactly* right at each reconcile. A Tier-A delete can
be up to one reconcile period stale. Yes/no on that trade determines whether S4 is mandatory before
S3 ships to the device.

**Q4 — Archive full `.noopbak` snapshots to Tigris?** Cents per month, turns disaster recovery from
"get a 200 MB phone upload to complete" into a server-side restore, and gives the delta chain a
trustworthy baseline. *(Recommendation: yes, at S2.)*

**Q5 — `rrInterval` ordering.** Confirm `seq` is a true within-second beat sequence (it is part of the
`v24-rr-seq` 4-column PK). If so, `Mirror.rrIntervalsRange` should move to `ORDER BY ts, seq` **before**
any merge ships, and the rowid dependency should be deleted. If `seq` is *not* reliably ordered, this
becomes a real blocker for merging into `rrInterval` and needs a different answer.

**Q6 — `rawBatch` in the backup: keep or exclude?** It is a transient BLE outbox, soft-capped ~50 MB on
the phone, actively evicted by `PrunePolicy`, **0 rows in the mirror**, and read by nothing. Excluding
it saves up to 50 MB per full upload and removes a partition that can never converge. But it holds raw
frames, and the standing rule is never to discard raw sensor streams — noting that the *durable* raw
archive is the Tigris deep-buffer path, not `rawBatch`. **This is a judgement call, not a technical
one.**

**Q7 — Retention.** Is the mirror meant to hold all history forever? The answer sets whether §6.4 cold
tiering is "probably never" or "eventually scheduled".

**Q8 — Who owns `noop-cloud` next?** Another agent is mid-flight on `harden/storage-guardrails` with
16 modified files and an untracked `src/zipstream.ts`. **S1 and S2 are server-only and will conflict.**
Land and commit the streaming work first.

---

## 11. Appendix: measurements this document rests on

All taken 2026-07-26 unless noted. Reproduce with `data_freshness`, `streams`,
`deep_buffer_coverage`, and `GET /status`.

```
mirror                  534,204,416 B   (2026-07-18T05:28:49Z)
phone database             ~608 MB      (2026-07-26, per brief)
→ growth                  ~8.3 MB/day   (74 MB / 8.9 days)
volume total (statfs)  3,134,808,064 B
volume free            2,444,197,888 B  (78% free)
server.sqlite               1,495,040 B
MAX_INGEST_BYTES       1,073,741,824 B  (config.ts and fly.toml agree)
MIN_FREE_BYTES           268,435,456 B
last successful ingest  2026-07-18T05:31:45Z  (8.9 days stale)
computed disk ceiling        ~1.16 GB
total rows                 ~7,919,519   (Tier A 7,905,443 · Tier B 14,076)
deep-buffer archive     210,402,099 B raw → 46,941,192 B stored (4.48×), configured: true
SQLite-in-zip ratio            ~3×      (608 MB → ~200 MB)
```

**Not measured, and worth measuring before S3:** a `dbstat` per-table byte breakdown of the mirror.
Nothing in either repo has ever run `PRAGMA page_count`/`dbstat`, so the byte-share estimates in §2 are
derived from row counts and column widths, not observed. This is the input to **Q6** and to
cost/benefit item 3 in §8.
