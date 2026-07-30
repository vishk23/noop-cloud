# The receive side: liters page replication into `mirror.sqlite`

Status: **built, tested, not deployed.** This is the server half of the plan in
[`SYNC_BUILD_VS_BUY.md`](./SYNC_BUILD_VS_BUY.md) — specifically the 2026-07-27 revision at the head
of that document, which withdrew the custom `/sync-manifest` + `/ingest-pages` protocol (§1.2, P3)
in favour of adopting [`liters`](https://github.com/mrkurt/liters) and its own HTTP replication
protocol. **Where §1.2 and the revision disagree, the revision wins**: nothing here invents a wire
format.

`POST /ingest` is untouched, still the fallback, and still the recovery path. The liters path is
**off by default** and does nothing until `LITERS_SINK_ENABLED=1`.

---

## 1. Shape

```
iPhone — liters Writer, background URLSession
  │  PUT /liters/ltx/0/{min:016x}-{max:016x}.ltx        (a few hundred KB, not 766 MB)
  ▼
Express  src/liters/proxy.ts
  │   bearer auth (rw) → disk preflight → size ceiling → bounded drain → stream through
  │   mount prefix stripped by Express; token swapped for a loopback-only one
  ▼
noop-liters-sink  (Rust, 127.0.0.1:9736, child process of Node)
  ├─ liters_storage::HttpServer { writable: true, auth_token }   ← THE PROTOCOL, verbatim
  │     └─ DirReplicaClient → /data/ltx-bucket                   ← litestream `file` layout
  └─ Replica::sync()  every 1s                                   → /data/mirror.sqlite, IN PLACE
                                                                       ▲
                                                       19 MCP read call sites, unchanged
```

**What is ours and what is liters'.** Every byte on the wire is handled by liters' `Mount`: the
endpoint grammar, listing lines, writer leases, TXID monotonicity, the byte-identical idempotent
re-push check, the bounded drain on error paths, `x-liters-protocol`. It is specified normatively in
the liters repo's `docs/http-protocol.md` and tested there against a Go litestream oracle. This repo
contributes configuration, a disk preflight, a corpse sweeper, a journal-mode fixup, a takeover
procedure, and a status file — roughly 700 lines of Rust and 400 of TypeScript, none of it protocol.

**Dependency pin.** `liters-sink/Cargo.toml` pins `github.com/vishk23/liters` at rev
`cdab02a` (branch `noop-integration`) — upstream `108e1df` plus VK's five branches plus
`fix/replica-lock-deadlock`. The rev, not the branch: the receive side is the only thing between the
phone and the mirror, and "whatever the branch was that day" is not a dependency.

---

## 2. The lock hazard

`Replica::apply_spooled` writes pages **into the live mirror** and, before the first one, takes
SQLite's EXCLUSIVE lock pair (the PENDING byte plus the SHARED range) with `fcntl`. The MCP tools
open that same file from another process. POSIX record locks only conflict across processes, which is
exactly the production configuration.

Upstream liters acquires with `fcntl(F_SETLKW)` — blocking, no timeout, no interruption point. A
reader holding a transaction parks the applier in the kernel forever, and nothing recovers it: not a
`CancelToken` (a thread inside `fcntl` never reaches a poll site), not `SIGTERM`. On this server such
a reader is routine — `streams` chains ~100 statements and `data_freshness` runs
`MAX(date(ts,'unixepoch'))` over ~3M rows.

The pinned rev replaces that with a bounded, cancellable `F_SETLK` poll
(`ReplicaOptions::lock_timeout`, default 5s), holding PENDING across the SHARED retries so arriving
readers cannot starve the applier. Contention surfaces as `Error::LockBusy`, which is **transient and
writes nothing** — the lock precedes the first page.

Verified in `liters-sink/tests/contention.rs`, with a real `node` + `better-sqlite3` reader process
on the other side of the lock:

| test | asserts |
|---|---|
| `a_node_reader_cannot_wedge_the_applier` | contention is bounded; against `F_SETLKW` this test hangs rather than fails |
| `a_refused_apply_leaves_the_mirror_untouched` | byte-identical mirror after a `LockBusy` |
| `the_applier_waits_a_reader_out_and_then_applies` | bounded ≠ starved: it gets in on its own |
| `replication_resumes_by_itself_after_the_reader_commits` | no operator step |
| `a_stream_of_arriving_readers_does_not_lock_the_applier_out` | 1,090 Node reads / 0 `SQLITE_BUSY` during an apply, and the apply still lands |

There is also a **compile-time** guarantee: `lock_timeout` and `Error::LockBusy` do not exist on
pre-fix liters, so pinning the sink at an unfixed rev fails the build with `E0560`/`E0599` rather
than silently reintroducing the wedge.

---

## 3. Journal mode is load-bearing

liters materializes a bucket two ways, and only one of them stamps the SQLite header.

- `apply_spooled` (incremental) sets header bytes 18/19 to `0x01` — rollback journal — and
  randomizes the change counter at 24..28 so other connections drop their page cache.
- `full_restore` (bootstrap) pipes the merged LTX through `decode_database_to` and preserves the
  **source's** header. The phone's GRDB database is WAL, so a fresh restore lands a mirror claiming
  WAL mode with no `-wal` and no `-shm`.

Measured consequence, on this repo's own reader configuration
(`new Database(path, { readonly: true, fileMustExist: true })`, `src/mirror.ts:57`):

```
header[18],[19] = 2 2
readonly open: OK; rows = 1
after readonly attempt, sidecars: [ 'm.sqlite', 'm.sqlite-shm', 'm.sqlite-wal' ]
```

The read **succeeds** — which is why a smoke test would not catch it — and in succeeding it creates
`-wal` and `-shm` on the data volume. `SQLITE_OPEN_READONLY` restricts writes to the database, not to
its sidecars.

Two things break, and the second is the serious one:

1. every MCP read starts creating files on a volume that has already been to zero bytes free;
2. **the applier/reader mutual exclusion silently stops working.** A WAL-mode connection takes
   neither of liters' rollback-journal locks and does not consult the change counter — it reads
   through the `-shm` index, which describes a file being rewritten underneath it.

So `liters-sink/src/mirrorfix.rs` enforces the invariant *the mirror always presents as a
rollback-journal file*, as a single 10-byte `pwrite` over bytes 18..28 (versions + change counter, so
a reader cannot see one without the other), plus removal of any stale sidecars. It runs at startup
and immediately after every sync. liters' own post-restore `quick_check` is disabled
(`IntegrityCheck::None`) because it opens the mirror read-only *before* the fixup and re-creates the
sidecars `full_restore` just deleted; the sink runs the same check itself, afterwards.

**Residual window, stated plainly:** `full_restore` publishes by `rename(2)` and the fixup runs when
`sync()` returns, so there are milliseconds in which the mirror exists with a WAL header. It is
bootstrap/re-baseline only, when no client can be mid-query against a file that did not exist a
second ago, and any sidecars created in it are removed by the same pass.

**Note this is not new with liters.** Today's `/ingest` mirror is *already* WAL-headed with no
sidecars, so every MCP read is already creating them — `src/ingest.ts` deletes `-wal`/`-shm` before
each swap, which is the evidence. The fixup makes that stop.

---

## 4. Coexisting with `/ingest`

The two paths share exactly one file and have exactly one moment of coordination.

**`/ingest` → liters.** A completed swap replaces `mirror.sqlite` with a database from a different
lineage. The `-txid` sidecar and the LTX bucket then describe a file that is gone, and applying them
onto the new one splices two histories together — the worst outcome available here. So a successful
swap calls `invalidateLitersLineage`, which removes **the bucket first, then the sidecar**. Every
interleaving of that order is a no-op for the sink; the reverse order would trigger the takeover path
against a stale bucket. A failed ingest invalidates nothing.

**liters → `/ingest`.** Nothing. `/ingest` is unchanged apart from that one hook, which is inert on a
config with no `liters` section — i.e. on every server today, and in every existing test.

**Takeover.** `Replica::sync` refuses outright when the mirror exists without a `-txid` sidecar. That
is the *normal starting condition here*: `mirror.sqlite` is already on the volume, put there by
`/ingest`, and has never heard of liters. Without handling it, switching the phone over would leave
replication permanently stalled on `replica exists but has no -txid sidecar` while `/status` looked
fine. `Sink::prepare` therefore renames the incumbent aside to `mirror.sqlite.pre-liters` (same
filesystem, free), restores from the bucket, verifies with `quick_check`, and rolls the incumbent
back if either step fails. `LITERS_ADOPT_EXISTING_MIRROR=0` makes it refuse instead.

---

## 5. Disk

Two preflights, deliberately sharing one floor (`MIN_FREE_BYTES`, passed to the sink as
`LITERS_MIN_FREE_BYTES`) so they cannot disagree and strand a push that was accepted but can never be
applied.

**On the push** (`src/liters/proxy.ts`): `requireSpaceFor(contentLength * 2)` — a byte of push costs
about two in transit (spool, then bucket). A chunked push has no length, so the term degrades to the
headroom floor, which is the number that actually mattered on 2026-07-26. `507`, never `400`: the
push is valid and should be retried.

**On the apply** (`liters-sink/src/space.rs`): exact arithmetic, not a guess. Every LTX header
carries `commit` (post-apply database size in pages) and `page_size`, so
`needed = largest pending LTX size + max(0, commit×page_size − current size) + headroom`.

This matters more than under `/ingest`, because an ENOSPC now lands **inside the live mirror** rather
than in a throwaway `.staged-*.sqlite`. The torn state is self-healing — `{db}-txid` only advances
after a *completed* apply, so the next round re-applies the same file and rewrites every page — but
"heals once there is space" is not a reason to start.

**`TMPDIR` is pointed at the volume.** `liters_storage::http::unlinked_temp_file` spools every PUT
body into `std::env::temp_dir()`, which on a Fly machine is the container root filesystem, not the
10.5 GB volume. A snapshot push would fill the rootfs while the volume sat empty.

---

## 6. Orphaned artifacts

The 2026-07-26 outage was `.staged-<random hex>` files: every failure minted a **new** name and left
the partial behind, consuming the space the next attempt needed. 2.4 GB of them took the volume to
zero. So, precisely, where liters stands:

| artifact | naming | can it accumulate? |
|---|---|---|
| `{db}.apply.tmp`, `{db}.tmp`, `{db}.compact.tmp`, `{db}-txid.tmp` | **fixed** siblings | No — `File::create` truncates, so a corpse is overwritten, not joined |
| HTTP PUT spool | created then immediately `unlink`ed | No — the kernel reclaims it on any exit |
| **bucket LTX temp** | `{min}-{max}.ltx.{pid}-{seq}.tmp` — **unique per write** | **Yes.** pid varies across restarts, seq within one, and nothing in liters collects them |

The brief's premise that "liters uses fixed `tmp_sibling()` paths with no randomisation" holds for
`replica.rs` but **not** for `dir.rs`, where uniqueness is deliberate: a shared temp path would let a
retry's cleanup unlink a racing first attempt's in-flight file. Correct, and exactly the accumulating
shape that filled the volume. Hence `liters-sink/src/sweep.rs`, with the same age guard
`sweepStagedArtifacts` uses — a temp file seconds old belongs to a push happening right now.

---

## 7. Do the MCP readers need changing?

**No.** All 21 call sites open read-only, close in a `finally`, hold no explicit transaction, use no
`.iterate()`, and span no `await`. The SHARED lock is therefore acquired and released *per statement*,
so the applier gets in between statements and no reader can hold it open across an async boundary.

Two changes were made **around** them, neither altering a successful read:

- `Mirror` gained an optional `busyTimeoutMs`. Every tool call site omits it and keeps
  better-sqlite3's 5000 ms default. Only `/healthz`'s probe passes it (1500 ms), because Fly's check
  timeout is *also* 5s — an un-tuned probe would time out the check instead of returning a verdict,
  and a failed check pulls a healthy machine out of routing. `SQLITE_BUSY` from the probe now reads
  as `{ok: true, busy: true}`: a busy mirror is replication working, not a degraded volume.
- The MCP storage guard gained a `SQLITE_BUSY` branch. It is a newly-possible error, and the existing
  message would have told the caller the volume is degraded and the call will keep failing — the
  opposite of true.

**One semantic change worth knowing about, deliberately not "fixed".** Under `rename(2)` a connection
kept its inode for its whole life, so a multi-statement call saw one consistent snapshot. Under
in-place application it does not: `streams` (~100 statements), `data_freshness` (~9) and
`sleep_detail` (up to 9) can straddle an apply and see some tables newer than others. The window is
milliseconds per apply and the data is append-only biometrics, so the observable effect is "one table
is 30 seconds fresher than another".

Restoring snapshot isolation is a one-line change — wrap each call in `BEGIN`/`COMMIT` — but it costs
the opposite property: `streams` cold-scans essentially the whole 766 MB file at ~21 MB/s, so it would
hold the read lock for *tens of seconds* and force the applier into repeated `LockBusy`. Per-statement
isolation is the better trade here. Recorded as a decision, not an oversight.

---

## 8. Enabling and deploying

Build, test, commit, push — **not deployed**. To deploy:

```bash
fly deploy -a vk-noop-cloud
```

The `-a` is not optional: `fly.toml` on `main` says `app = "noop-cloud"`, so a bare `fly deploy`
targets the wrong app.

Deploying this changes nothing on its own. The image gains `/app/bin/noop-liters-sink` and the
`/liters` route answers a legible 503. To actually turn the path on:

```bash
fly secrets set LITERS_SINK_ENABLED=1 -a vk-noop-cloud    # or fly.toml [env]
```

Watch `GET /status` → `liters`: `running`, `restarts`, `behind` (bucketMax − position), `stalled`,
and `status.lockBusyTotal`. `noop-liters-sink --apply-once` runs one round by hand and exits 0
(applied/current), 3 (reader contention), 4 (no space), 1 (anything else).

To turn it off: unset the secret and redeploy. `/ingest` has been working the whole time.
