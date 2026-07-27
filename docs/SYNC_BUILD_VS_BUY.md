# Sync: build vs. buy — and what to build instead

> ## ⚠️ REVISION 2026-07-27: buy, don't build. `liters` is licensed and it is good.
>
> **What changed.** VK contacted Kurt Mackey directly and Kurt confirmed `liters` is being
> MIT-licensed and that VK is free to use it now — use, modify, file issues, open PRs. §3.9's
> "no LICENSE, all rights reserved, legally cannot vendor" verdict is **withdrawn**. That was the
> only blocker, and with it gone the recommendation below (build a custom page protocol, P3–P5)
> is **superseded**.
>
> **Also wrong in §3.9:** it said `liters` had no usable Swift story. It has one.
> `crates/liters-ffi` is 1,483 lines of UniFFI exporting `LitersWriter` / `LitersReplica` /
> `LitersManager`, and `scripts/build-ios.sh` produces a real `Liters.xcframework` for
> `aarch64-apple-ios` + both simulator arches.
>
> **Revised recommendation:**
> **P0 (page-churn telemetry) and P2 (phone operational hardening) still ship — they are
> measurement and reliability, and are not superseded by anything. P3, P4 and P5 (the custom
> `/sync-manifest` + `/ingest-pages` protocol) are cancelled. In their place, trial `liters` over
> its own HTTP push protocol, with the phone supplying `URLSession` through the transport seam.**
>
> **Read the code before trusting this summary — it is unusually good.** 21,380 lines of Rust,
> **zero** `TODO`, `FIXME`, `unimplemented!()` or `todo!()` anywhere. `crates/liters/src/verify.rs`
> is a branch-for-branch port of Litestream's `db.go:1499-1704` decision tree with the upstream
> issue numbers (#900, #927, #997, #896, #781) cited at each hardening. This is a careful port of
> battle-tested logic, not a reimplementation.
>
> ### The one thing that must be tested before committing
>
> `liters` ships **WAL frames**, so it must observe every transaction. It cannot, on iOS.
> `crates/liters/src/meta.rs:110-112` says so explicitly, and correctly:
>
> > *"sound while the read lock continuously prevents foreign checkpoints, which is false across a
> > writer close/reopen — a stale `true` could skip the snapshot that recovers commits checkpointed
> > while closed."*
>
> So the issue-#927 "expected truncation" shortcut is deliberately **not trusted across an app
> restart** — which on iOS is every single time. And `crates/liters/src/checkpoint.rs:1-3`:
> *"Because the writer's long-running read transaction starves every other checkpointer (including
> the app's wal_autocheckpoint), liters MUST checkpoint the database itself."*
>
> **The failure mode, concretely:** the app is killed, GRDB's `wal_autocheckpoint` (default 1000
> pages = 4 MB) restarts the WAL, the app writes past `liters`' old resume offset, and
> `verify.rs:162` finds the last synced frame overwritten → `"wal overwritten by another process"`
> → **full snapshot of the whole 766 MB database.** That is precisely the upload we are trying to
> stop doing.
>
> **Mitigation, and it is the integration requirement:** set `PRAGMA wal_autocheckpoint = 0` in
> GRDB and let `liters` be the only checkpointer. WAL growth between pushes is then bounded by
> write volume — at 8.3 MB/day, a week offline is a ~58 MB WAL, which is fine. **The number to
> measure in the trial is how often a push degrades to `snapshotting = true`.** If it is rare,
> adopt. If it is routine, the physical-page-diff design in §1 is immune to this failure by
> construction (its delta is derived from data at rest, so a missed window costs a larger diff and
> never a full re-upload) and becomes the fallback rather than the plan.
>
> ### Transport: use liters' HTTP push, not direct-to-Tigris
>
> The tempting option is phone → Tigris (S3) directly, since `crates/liters-storage/src/s3.rs`
> genuinely writes litestream's bucket layout (`{prefix}/{level:04x}/{min:016x}-{max:016x}.ltx`)
> and the bucket already exists. **Don't.** Three reasons, in order:
>
> 1. **It cannot survive app suspension.** `Storage::S3` drives `object_store`/reqwest/rustls/tokio
>    — its own networking stack. iOS only completes an upload after the app suspends when the
>    transfer belongs to a background `URLSession`. `Storage::Http` has a **pluggable transport
>    seam** (`#[uniffi::export(with_foreign)] HttpClient`) that lets Swift supply the request —
>    i.e. the app's own background `URLSession`. That is the difference between a sync that
>    finishes in the background and one that dies at suspension.
> 2. **It puts bucket-write credentials on the device.** Litestream's model assumes a trusted
>    server. `Storage::Http` uses `Authorization: Bearer <token>`, matching the existing scheme.
> 3. **Binary size.** The `s3` feature is off by default precisely because it "pulls in
>    `object_store` + the reqwest/hyper/rustls/tokio async stack (several MB of `.so`) that a
>    mobile app following over HTTP never uses" (`crates/liters-ffi/Cargo.toml:17-19`).
>
> ### What this costs, honestly
>
> **There is no `liters` CLI binary.** The only `[[bin]]` in the workspace is `uniffi-bindgen`.
> The server half is a library, so the Fly machine needs a small Rust program VK writes and
> maintains (serve the push endpoint, run `Replica::sync()` to keep `replica.db` current),
> plus a Rust toolchain in the Docker build and a second process next to Node. That is the real
> price of adoption and it is not zero — but `Replica::sync()` does produce a plain on-disk SQLite
> file that `better-sqlite3` opens read-only, so **all 19 MCP call sites stay unchanged.**
>
> **Licence caveat, worth closing before shipping:** as of 2026-07-27 the public repo still has
> **no LICENSE file**, GitHub's licence metadata is `null`, `Cargo.toml` says `Apache-2.0` (not
> MIT), and issue #1 has no reply. Kurt's grant to VK is real but currently out-of-band. Ask him to
> push the file and reconcile the `Cargo.toml` field before this becomes load-bearing.
>
> The rest of this document is preserved as written. §1 (the physical page protocol) is now the
> **fallback design**, not the plan; §3.9's verdict on `liters` is withdrawn; everything in §2
> about why physical beats logical still stands and is in fact the argument *for* `liters`.

Status: **decision document.** Written 2026-07-26/27, after the streaming-ingest fix landed and the
phone successfully uploaded 153.4 MB (mirror 534 MB → 766 MB, `lastIngestAgeSeconds` back to 167 s,
9.3 GB free on the extended 10 GB volume). Nothing is on fire. This is an architecture call made
calmly.

Baseline being argued against: [`DELTA_SYNC_DESIGN.md`](./DELTA_SYNC_DESIGN.md) — the tiered,
partition-reconciling **row-level** delta protocol. Read that first; this document assumes it.

Framing, from VK: *"it seems like we keep tripping over ourselves and building the wrong thing."*
That is the question actually being answered here. Sunk cost is not an argument in either direction.

---

## 0. Verdict, up front

**Do not adopt a mobile sync product. Do not build the row-level delta protocol either.**

Three findings, in order of how much they should change your plans:

1. **The mobile-sync market genuinely does not serve your topology, and the disqualifier is not
   "phone is primary" — it is "the app owns its own schema."** PowerSync, ElectricSQL, Turso, Realm,
   Couchbase Lite and WatermelonDB all require that *they* define and own the on-device tables.
   `Packages/WhoopStore/Database.swift` is upstream-shared, has ~31 hand-written GRDB migrations, and
   carries a byte-identical Room twin. Every one of these products is disqualified before the
   topology question even comes up. This is not a cop-out; it is a structural fact with citations
   in §3.

2. **But the *right* answer is a bought idea, not a built protocol.** Every serious system that
   replicates SQLite one-writer→many-readers converged on the same mechanism: **physical, page-level
   replication.** Litestream, Verneuil, Graft, Turso's sync, and — decisively —
   **`sqlite3_rsync`, which is a 76 KB C file inside SQLite core itself**, all ship *pages*, not
   rows. Page-level replication is schema-agnostic, so migrations propagate for free, deletes and
   mutations are free, the mirror stays **byte-identical**, and there is no protocol that can drift.
   None of these run *as a library on iOS* today, which is why you can't literally `import` one — but
   the design is not yours to invent, and you should stop inventing it.

3. **Your three real failures were operational, not protocol.** A leaked temp file filled the disk;
   a buffered read OOM-killed the process; a non-`defer`'d lock wedged the client for 10 days. The
   row-level design in `DELTA_SYNC_DESIGN.md` would have prevented **none** of them, and would have
   added ~1,500 lines of schema-aware, two-language, silently-divergent surface area on which the same
   class of bug can recur. Optional protocol elegance is not what you are short of. **Deleting code
   from the ingest path is.**

### The recommendation

> **Build "physical delta sync": ship changed 4 KB SQLite pages instead of rows, verified end-to-end
> by a whole-file hash. Keep `POST /ingest` as the fallback. Adopt Litestream for real, but only
> server-side, only for `server.sqlite`. Use `sqlite3_rsync` as the correctness oracle in tests.**

Why this is the right shape and not just a third custom thing:

- It is **~1/10th the protocol surface** of the row-level design. No tiers, no partitions, no
  watermarks, no per-table digests, no `_delta_op` opcode table, no schema fingerprint, no reconcile
  subsystem, no Tier-A/Tier-B distinction, no `implausible_ts` guard, no `TimestampHeal` watermark
  trap. The unit is "page N has these 4096 bytes." That is the entire wire format.
- It is **provably correct at runtime, per sync**, which nothing else on the table is. The phone
  hashes its whole file; the server applies pages to a staged copy and hashes the result; if the
  hashes differ the batch is rejected and the phone falls back. The `DELTA_SYNC_DESIGN.md` §8 risk —
  *"the mirror stops being a byte-identical copy… every future bug is a silent divergence instead of
  a loud failure"* — **is designed out, not mitigated.**
- It requires **zero phone migrations, zero Kotlin twin, zero coupling to WhoopStore's schema.** The
  same property the row-level design fought for (§9), obtained for free rather than by careful
  construction — because a page diff literally cannot see a schema.
- It **deletes** `src/zipstream.ts` (the hand-rolled 12 KB ZIP reader), the `adm-zip` dependency, the
  1 GiB body-size preflight arithmetic, the 3× inflate amplification, and most of `src/staging.ts` —
  i.e. exactly the code where two of your three real failures lived.
- The changed-page payload for a routine sync is an estimated **0.4–6 MB** (§2.4), against 153.4 MB
  today. Comfortably inside a `BGAppRefreshTask`.

**The first thing to build is not the protocol.** It is ~40 lines of telemetry in `src/ingest.ts`
that counts how many 4 KB pages actually differ between the outgoing mirror and the incoming
snapshot. That single number decides whether this whole plan is right, it ships today with zero
risk, and the hash function it introduces is the core of the protocol later. See §1.3, stage **P0**.

---

## 1. What to build

### 1.1 Target architecture, end to end

```
┌─ iPhone ────────────────────────────────────────┐
│  GRDB / WhoopStore   noop.sqlite  (~766 MB)     │   unchanged. no migration. no new table.
│         │                                       │
│  PhysicalSync (fork-only, #if CLOUD_SYNC)       │
│    1. store.checkpointForBackup()  (WAL TRUNCATE)│  ← reuses the existing DataBackup guard
│    2. pool.read { }  ← scoped, auto-released     │  ← pins the main file; blocks checkpoints
│    3. hash pages 0..N-1  (xxHash64, 8 B each)    │  ← ~2-5 s, streaming, no allocation spike
│    4. diff vs. locally cached hash array         │  ← ~1.5 MB file in Caches/, pure cache
│    5. POST changed pages  (background URLSession) │
└─────────────────────────────────────────────────┘
                     │  POST /ingest-pages   (few hundred KB … few MB)
                     ▼
┌─ Fly machine (shared-cpu-1x, 2 GB, 10 GB vol) ──┐
│  Express                                         │
│    6. stream body to .staged-<hex>.pages         │  ← bounded, O(1) RAM (already true today)
│    7. cp mirror → .staged-<hex>.sqlite           │  ← LIVE MIRROR NEVER WRITTEN (invariant kept)
│    8. pwrite each page; truncate/extend to N      │
│    9. whole-file hash == phone's?  else 409       │  ← the correctness proof
│   10. PRAGMA quick_check                          │
│   11. rename(2) → mirror.sqlite                   │  ← unchanged atomic swap
│                                                   │
│  server.sqlite  (editJournal, deepBufferChunk)   │
│    └─ litestream replicate → Tigris              │  ← the one genuine "buy". ~15 lines of config
│                                                   │
│  MCP tools: 19 × new Mirror(path) readonly        │  ← ZERO changes. §5 of DELTA_SYNC_DESIGN holds
└─────────────────────────────────────────────────┘
                     │
                     ▼
┌─ Tigris ────────────────────────────────────────┐
│  vk-noop-deepbuf/     deep buffer payloads       │  unchanged
│  vk-noop-serverdb/    litestream LTX (server.sqlite)  ← new, ~cents/month
│  vk-noop-snapshots/   one full .noopbak / month  │  ← new, restore baseline, ~cents/month
└─────────────────────────────────────────────────┘
```

**MCP read consistency is unchanged and stays free.** The merge happens in a throwaway copy and the
live mirror is only ever replaced by `rename(2)`. A tool call that started before the swap keeps its
inode; one that starts after sees the new one. No tool can observe a half-applied mirror because a
half-applied mirror never appears at `mirrorPath`. The edit overlay (`src/edits/overlay.ts`, read
from `server.sqlite`) is orthogonal and untouched. This is verbatim the argument in
`DELTA_SYNC_DESIGN.md` §5 and it carries over intact — deliberately, because it is the single most
valuable property the current server has.

**Server→phone stays exactly as it is.** `CloudEditApplier` / `CloudTombstoneStore` pull confirmed
edits over the existing JSON endpoints and apply them to the phone DB. Those edits then flow back to
the mirror as *pages*, like any other write. Physical replication makes this cleaner, not harder:
there is exactly one writer of mirror bytes (the phone), and the server's write-side state stays
confined to `server.sqlite`.

### 1.2 The protocol, in full

That heading is not a joke — this is the whole thing.

**`GET /sync-manifest`** (scope `rw`)
```jsonc
{ "protocol": 1,
  "bootstrapRequired": false,
  "pageSize": 4096,
  "pageCount": 187012,
  "fileHash": "…",              // xxHash3-128 or BLAKE3-128 of the whole mirror file
  "pageHashes": "<base64 or raw octet-stream: 8 bytes × pageCount>" }   // ~1.5 MB
```
Served from a cache in `server.sqlite` keyed by the mirror's `(mtime, size)` — computed once per
swap, not once per request.

**`POST /ingest-pages`** (scope `rw`, `application/octet-stream`)

Body: a tiny header (`protocol`, `installId`, `batchId`, `pageSize`, `pageCount`,
`expectedBaseFileHash`, `resultFileHash`), then a repeated `(uint32 pageIndex, 4096 bytes)` stream,
zstd- or deflate-framed. Reuses `receiveUploadBody` and `URLSession` upload-from-file verbatim.

Server: copy → apply → truncate/extend to `pageCount` → **hash the result and compare to
`resultFileHash`** → `quick_check` → swap.

| code | meaning | phone must |
|---|---|---|
| 200 | applied, hash verified | advance the cached hash array |
| 409 `base_mismatch` | `expectedBaseFileHash` ≠ current mirror | re-`GET /sync-manifest`, rebuild, retry once |
| 409 `result_mismatch` | applied file did not hash correctly | discard cache, fall back to full `/ingest` |
| 409 `bootstrap_required` | no mirror, or `installId` changed | full `/ingest` |
| 400 `bad_batch` | malformed | discard, log, **do not loop** |
| 413 / 507 | too large / no space | keep the batch, back off, retry |

There is no watermark, no digest, no partition, no reconcile, no tombstone, and no schema list.
Divergence is not "eventually repaired by a weekly job" — it is **impossible to commit**, because a
mirror that does not hash to the value the phone computed over its own file never gets renamed into
place.

**Why the phone caches its own hash array instead of always downloading the manifest.** Steady state
becomes upload-only: no 1.5 MB download per sync. The cache is *purely* a cache — `expectedBaseFileHash`
proves it was valid, and any mismatch costs one extra round trip. Delete the file and the system
still works, just one manifest fetch slower. That is the correct shape for a cache on a device that
gets wiped, restored, and reinstalled.

**Consistency of the phone-side snapshot**, three independent guards, because this is the one place
a subtle bug would be expensive:
1. `checkpointForBackup()` (WAL `TRUNCATE`) — after this the single file *is* the whole store.
   Already exists, already used by `DataBackup`, already a hard guard (`Strand/Data/DataBackup.swift:50-53`).
2. Hash inside a GRDB `pool.read { }`. In WAL mode an open read transaction prevents the checkpointer
   from copying WAL frames into the main file, so the bytes cannot move under you. This is precisely
   the trick Litestream uses: *"It starts a long-running read transaction to prevent any other
   process from checkpointing and restarting the WAL file"*
   ([litestream.io/how-it-works](https://litestream.io/how-it-works/)). GRDB's closure form gives you
   `defer`-equivalent release for free — **which is the specific bug class that cost you 10 days.**
3. `resultFileHash` verified server-side. If 1 and 2 both failed, the batch is rejected. You do not
   have to *reason* that the snapshot was consistent; the server *checks*.

### 1.3 Staged plan — every stage independently shippable and independently valuable

| stage | what | effort | ships value even if you stop here |
|---|---|---|---|
| **P0** | **page-diff telemetry in `ingest.ts`** | **1–2 h** | **yes — it produces the number that decides everything** |
| P1 | Litestream → Tigris for `server.sqlite` | 1–2 h | yes — DR for the only irreplaceable server state |
| P2 | phone operational hardening (no protocol) | ~1 day | yes — this is what would have made the outage 4 h, not 10 days |
| P3 | server `GET /sync-manifest` + `POST /ingest-pages` | 2–3 days | yes — manifest alone audits `contentToken` against reality |
| P4 | phone `PhysicalSync` uploader, behind a toggle | 2–3 days | **this is where sync-on-every-wake lands** |
| P5 | deletion pass | ~1 day | yes — smaller attack surface, less to go wrong |
| P6 | monthly full snapshot → Tigris | 2 h | yes — restore baseline |

Total ≈ **8–11 working days**, against ≈ 4–6 weeks for `DELTA_SYNC_DESIGN.md` S1–S4.

---

#### **P0 — page-diff telemetry. Build this first. (1–2 hours, server-only, zero risk)**

In `src/ingest.ts`, immediately before the atomic swap — when you are holding both the *outgoing*
mirror and the *incoming* staged snapshot on disk, which you already are — walk both files 4 KB at a
time and log:

```
pageSize, oldPageCount, newPageCount, pagesChanged, pagesAdded,
changedByteRange (min/max index), estimatedCompressedDeltaBytes
```

**What it buys.** One number: *what fraction of pages actually change between two of VK's real
syncs.* Every claim in §2.4 is an estimate until this runs. If it comes back at ~2,000–5,000 pages
(1–3%), physical delta sync is decisively correct and you build it. If it comes back at 40% because
something is churning the freelist or rewriting B-trees wholesale, **you have falsified this document
for the cost of an afternoon** and you should go re-read `DELTA_SYNC_DESIGN.md` §2 with fresh eyes.

It is also independently useful forever: it is a free, continuous corruption/churn canary, and it
will tell you whether `rawBatch` eviction (open question **Q6** in the old design) is actually costing
you anything.

The 8-byte page hash function it introduces is the same one P3 and P4 use. Nothing is thrown away.

**Deletes:** nothing yet.

---

#### **P1 — Litestream for `server.sqlite` → Tigris. (1–2 hours)**

This is the one place you should genuinely **buy**, and it is embarrassingly cheap.

`data/server.sqlite` holds the `editJournal` (every AI-proposed correction VK has confirmed) and
`deepBufferChunk` (the index for 210 MB of raw archive in Tigris). **The mirror is reproducible from
the phone. `server.sqlite` is not reproducible from anything.** It is currently 53 KB–1.5 MB, written
in place, single-writer, on a volume that has already filled up once.

That is the exact shape Litestream was built for. Add to the Dockerfile and an entrypoint:

```yaml
# litestream.yml
dbs:
  - path: /data/server.sqlite
    replicas:
      - type: s3
        endpoint: https://fly.storage.tigris.dev
        bucket: vk-noop-serverdb
```

Litestream is Apache-2.0, 14.0k stars, `v0.5.15` released **2026-07-21**, actively maintained by Ben
Johnson under Fly's sponsorship ([repo](https://github.com/benbjohnson/litestream),
[v0.5 writeup](https://fly.io/blog/litestream-v050-is-here/)). Cost: a few MB in Tigris, cents.

**Do not point Litestream at the mirror.** The mirror is replaced by `rename(2)`, which breaks WAL
continuity; Litestream would re-snapshot 766 MB on every swap. Mirror DR is P6's job.

**Deletes:** nothing. **Adds:** one sidecar process and ~15 lines of config, in exchange for
"the confirmed-edit journal cannot be lost."

---

#### **P2 — phone operational hardening. No protocol. (~1 day)**

Lift verbatim from `DELTA_SYNC_DESIGN.md` §7 S0.5 — that section was right and is unaffected by
anything in this document:

- `CloudSyncClient` must stop collapsing every non-2xx into `badResponse(status, prefix)`. 413
  (`too_large`, discard) and 507 (`insufficient_space`, **keep the archive and retry**) mean opposite
  things and the phone currently cannot tell them apart.
- Retry with bounded backoff + jitter. Today the only retry is the next scheduled sync, 4–20 h later.
- Move the upload to a **background `URLSessionConfiguration`** (`uploadTask(with:fromFile:)` — note
  the `async upload(for:fromFile:)` form used at `CloudSyncClient.swift:121` runs on
  `URLSession.shared` and has no background configuration, so suspension mid-transfer loses everything).
- **Fix the live `BGTaskScheduler` identifier mismatch.** `project.yml` / `Info.plist` say
  `com.vkchitti.noop.cloudsync.refresh`; `CloudSyncBackgroundRefresh.bgTaskIdentifier` still says
  `com.noopapp.*`. As the tree stands the background sync lane is dead.
- **Audit every lock and every temp file for `defer`.** Two of your three data-costing failures were
  a leaked temp file and a lock without a `defer`. Introduce one `withStagedFile { }` helper on each
  side and route *all* temp-file creation through it; give the server's merge lock a TTL so a stale
  lock self-clears instead of wedging for 10 days.

**What it buys:** this, alone, converts the failure you actually had (10-day outage) into a 4-hour
one. It is the highest value-per-line change on the board and it is orthogonal to every architectural
question in this document.

**Deletes:** ad-hoc error paths in `CloudSyncClient` / `CloudSyncModel`.

---

#### **P3 — server: manifest + page ingest. (2–3 days, server-only, phone unaffected)**

`GET /sync-manifest` and `POST /ingest-pages` per §1.2. Exercised entirely from vitest; the phone
never calls them until P4.

Tests that must exist:
- applying a page batch twice yields a bit-identical mirror (idempotent by construction);
- a batch whose `resultFileHash` does not match leaves the mirror **bit-identical** (extend the
  existing "does not corrupt an existing mirror when the upload is invalid" test);
- shrinking `pageCount` truncates; growing extends;
- `base_mismatch` when the mirror moved under the phone;
- concurrent merges → 409, and the lock has a TTL;
- `requireSpaceFor` refuses a merge that will not fit (507).
- **Oracle test:** build two SQLite fixtures, run real `sqlite3_rsync` between them, and assert your
  page-apply produces the identical result. You get a reference implementation maintained by the
  SQLite team for free — use it (§3.7).

**What it buys before any phone change:** the manifest tells you exactly how large a delta *would* be,
and lets you audit the phone's `contentToken` against the mirror's reality — which will surface the
known hole where an equal-count in-place correction to `workout` or `metricSeries` does not move the
token, so today's system can silently decline to upload a correction.

**Deletes:** nothing yet — `/ingest` stays.

---

#### **P4 — phone: `PhysicalSync`. (2–3 days) ← the win lands here**

New fork-only files under `Strand/CloudSync/`, `#if CLOUD_SYNC`, behind a `CloudSyncSettings` toggle
defaulting **off**. VK flips it on his own device.

Flow is §1.1 steps 1–5. Fall back to full `/ingest` on: any 409, a page-size change, a page-count
change > ~40% (a rebuild or `VACUUM`), and any unrecognised failure. **`/ingest` is never removed.**
Worst case is exactly today's behaviour.

**What it buys:** a routine sync goes from 153.4 MB / 90–150 s to an estimated 0.4–6 MB / 2–5 s, which
fits a `BGAppRefreshTask`. That is the product change — sync on every wake instead of every 4–20 h.

**Deletes:** the `contentToken` skip-unchanged gate becomes vestigial (the page diff *is* the change
detector, and a strictly better one — it cannot miss an equal-count in-place edit). Keep it one
release as a cheap outer gate, then delete it and the `lastUploadedContentToken` UserDefaults key.

---

#### **P5 — the deletion pass. (~1 day)**

Once P4 has run on-device for a couple of weeks, `/ingest` becomes a rarely-exercised fallback rather
than the hot path, and the extreme hardening built for a 200 MB body is no longer load-bearing.

Delete or radically shrink:
- **`src/zipstream.ts` (12 KB)** — the hand-rolled ZIP central-directory reader with ZIP64 handling
  and `GuardStream`. The page protocol is a length-prefixed octet stream; it needs none of this.
  Keep the file only if `/ingest` retains the zip path — in which case shrink `MAX_INGEST_BYTES` and
  delete the ZIP64 branch.
- **`adm-zip`** — a production dependency retained "for test fixtures only."
- **the 1 GiB / 507 / disk-ceiling arithmetic** — a page batch is single-digit MB; the peak-disk
  computation in `DELTA_SYNC_DESIGN.md` §1 stops being a design constraint.
- **most of `src/staging.ts`'s multi-artifact sweep** — one staged artifact kind instead of three.
- on the phone: the 200 MB-scale export path from the *sync* lane (`DataBackup` keeps it for the
  user-facing "Export backup" feature, unchanged).

**This stage is the point of the whole exercise.** VK's stated problem is accreting patchwork. P5 is
where the accretion comes off. Everything before it is setup.

---

#### **P6 — monthly full `.noopbak` → Tigris. (2 h)**

`DELTA_SYNC_DESIGN.md` §6.2, unchanged and still right. Today a full upload is transient — the
compressed body is deleted the moment it is inflated, so if the volume is lost, the only copy of the
mirror is on VK's phone and recovery means getting a 150 MB upload to complete. One `put` per month
of an object that already exists on disk. Cents. Turns DR into a server-side restore.

### 1.4 Failure modes of the new design

The brief names three that bit him in the last 24 hours. Each gets an explicit answer.

**Server is down / 5xx.** The phone's cached hash array is only advanced on a `200` *whose
`resultFileHash` was verified*. A failed sync therefore leaves the phone's notion of "what the server
has" exactly where it was, and the next sync re-sends the same pages. There is no state to repair and
no way to lose a page. Degradation is *loud*: `mirrorAgeSeconds` climbs and `data_freshness` says so.
Contrast the row-level design, where a lost batch after a watermark advance is a permanent silent
hole until the weekly reconcile.

**Phone sleeps mid-upload.** Two layers. (a) The body is single-digit MB on a **background**
`URLSessionConfiguration`, so iOS completes the transfer after suspension — a thing the current
153 MB `URLSession.shared` upload structurally cannot do. (b) If the app is killed outright, nothing
was committed: the cache was not advanced, so the next wake re-sends. The upload is idempotent
because applying the same pages to the same base yields the same bytes.

**Sync interrupted mid-apply on the server.** The apply happens in `.staged-<hex>.sqlite`, a throwaway
copy. `ENOSPC`, a SIGKILL, an OOM, a bad page index — any of them leaves the copy orphaned (swept by
`sweepStagedArtifacts`) and **the live mirror bit-identical to what it was**. There is no partial
state to reason about. This is the same property the current swap has and it is deliberately preserved.

Four more the design must own:

**The phone's cached hash array goes stale** (server restored from backup, or a manual mirror
replacement). Caught by `expectedBaseFileHash` → 409 `base_mismatch` → one manifest refetch
(~1.5 MB) → correct batch. Bounded, automatic, one extra round trip.

**A hash collision.** 8-byte page hashes over 187k pages: birthday probability ~1e-10 per sync, and
even then the 128-bit whole-file hash catches it and rejects the batch. Say this in the code comment;
do not pretend it is cryptographic.

**`VACUUM`, a page-size change, or a destructive migration** (`v24-rr-seq` rebuilt a table;
`v26-efficiency-heal` ran `UPDATE … SET efficiency = efficiency/100.0`). Every page moves. Detected
by the >40% heuristic or a `pageSize` change → automatic full `/ingest`. Note there is currently **no
`VACUUM` anywhere in `Strand/` or `Packages/*/Sources/`** (grepped), so this is a guard, not a
routine path. In the row-level design the same events required the `_delta_schema` fingerprint
machinery of §4.7; here they fall out of comparing two integers.

**Write amplification on the volume.** A 766 MB `cp` per merge, ~8×/day ≈ 6 GB/day of writes to move
a few MB. Identical to the accepted cost in `DELTA_SYNC_DESIGN.md` §4.6 and accepted for the same
reason: it buys an unchanged read path for all 19 MCP call sites. Fly's NVMe absorbs it; the copy is
1–3 s. If it ever matters, that is the argument for in-place apply — and §5 of the old design still
correctly describes what that would cost.

### 1.5 What is NOT worth building

- **The row-level tiered delta protocol** (`DELTA_SYNC_DESIGN.md` §4). Superseded in full. It is
  more code, more coupled, and strictly weaker on correctness.
- **The digest/partition reconcile subsystem** (old S4). Unnecessary: the whole-file hash *is* the
  reconcile, it runs every sync instead of weekly, and it is exact rather than count-based.
- **Watermarks, `rowVersion`, change-journal tables, triggers.** Already rejected in §3 of the old
  design for schema-cost reasons; now rejected again for being unnecessary.
- **Any mobile sync engine** (§3.1–3.6). All disqualified on schema ownership before topology.
- **`liters` / a Rust FFI page-replication engine** (§3.8). Right idea, but 8 commits, 3 stars,
  17 days old, **no license file**, no releases. Watch it; do not depend on it.
- **`sqlite3_rsync` over a WebSocket** (§3.7). It is the theoretically best answer and it is worth
  understanding, but the integration cost (C interop on iOS, a bidirectional stream to replace ssh,
  and the two-SQLite-libraries-in-one-process locking hazard) exceeds the cost of the whole P0–P5
  plan. Use it as an oracle, not as a runtime.
- **In-place WAL merge on the server** (old S5). The copy is 1–3 s and the read path stays free.
- **Cold tiering the mirror to Tigris / DuckDB / Parquet** (old S6). Buy disk. You already did.
- **Any multi-writer / conflict-resolution story.** One user, one phone. Every CRDT system on the
  market solves a problem you do not have, at a schema cost you cannot pay.

---

## 2. Why physical beats logical, for *this* database

### 2.1 The asymmetry the old design found is real but points elsewhere

`DELTA_SYNC_DESIGN.md` §2 established that **99.8% of rows and ~95% of bytes live in 13 append-only,
`(deviceId, ts)`-keyed tables.** That finding is correct, well-measured, and it does make a row-level
protocol tractable. It is also, read one level down, an argument for the *physical* approach: rows
appended in `(deviceId, ts)` order land at the **end** of their B-trees, and their index entries land
at the end of theirs. Append-ordered inserts are exactly the access pattern under which a page diff
is nearly optimal — new pages, plus a thin spine of interior-node updates, and nothing else moves.

The row-level design has to *know* that fact and encode it as a "Tier A fast path." The page diff
just benefits from it.

### 2.2 What physical replication gets you that row-level cannot

| property | row-level (`DELTA_SYNC_DESIGN.md`) | physical (this doc) |
|---|---|---|
| mirror byte-identical to phone | **no** — a merged approximation | **yes, verified every sync** |
| divergence detection | partition `COUNT(*)` digests, weekly | whole-file hash, every sync, exact |
| schema migration | 409 `bootstrap_required` + full re-upload (§4.7) | **invisible** — pages carry it |
| deletes / mutations | needs `replace` + reconcile (old S4) | **free** |
| `TimestampHeal` unscoped range `DELETE`s | named trap, three defences (§4.2) | **free** |
| sleep sessions re-keyed by `IntelligenceEngine` | Tier-B whole-table replace | **free** |
| `rawBatch` churn "can never converge" (Q6) | must be excluded | **converges; Q6 becomes moot** |
| `rrInterval` rowid ordering / RMSSD hazard (§4.6) | must switch to `ORDER BY ts, seq` **first** | **free** — rowids are bytes |
| `ON CONFLICT` vs `INSERT OR REPLACE` subtlety | load-bearing correctness detail | **does not arise** |
| new phone migrations | zero (by careful design) | zero (structurally impossible) |
| Kotlin/Room twin needed | no | no |
| protocol surface | ~1,500 lines, 2 languages, schema-aware | ~500 lines, 2 languages, schema-blind |
| bytes per sync (8×/day) | ~300–500 KB | ~0.4–0.8 MB (est.) |
| phone CPU per sync | one indexed range scan | full-file hash pass, ~2–5 s |

Rows 3 through 9 are not conveniences. Each is a **named open risk or explicit workstream** in the
row-level design that simply ceases to exist. `rrInterval`'s ordering hazard is the sharpest example:
`DELTA_SYNC_DESIGN.md` §4.6 correctly identifies that `INSERT OR REPLACE` would reassign rowids and
provably corrupt RMSSD, and makes "switch `Mirror.rrIntervalsRange` to `ORDER BY ts, seq`" a blocking
prerequisite. Under physical replication the rowids *are* the bytes you copied. There is nothing to
get wrong.

### 2.3 What you give up

Two things, honestly:

1. **A full-file hash pass per sync.** ~766 MB read + hashed. On iPhone NVMe with xxHash64 (multi-GB/s)
   this is ~2–5 s, dominated by I/O. It grows with the database: at 8.3 MB/day you are at ~1.6 GB in
   three years, so ~5–10 s. That is still inside a `BGAppRefreshTask`, but it is a real term where the
   row-level design has none. If it ever becomes the binding constraint, the fix is to make the hash
   pass resumable across wakes (hash range `[a,b)`, persist, continue) — not to change protocols.
2. **Slightly more bytes on the wire** — a page carries whole rows *and* their neighbours *and* index
   entries. Estimated 0.4–6 MB/sync vs 0.3–0.5 MB. At LTE's ~3 MB/s this is a 0.1 s vs 2 s difference
   inside a 30 s budget. It does not matter.

Neither is worth 1,000 extra lines of schema-coupled protocol.

### 2.4 The numbers (estimates — **P0 replaces them with measurements**)

Mirror 766 MB at `page_size = 4096` (confirmed from `data/server.sqlite`'s header; the mirror
inherits the phone's GRDB default, which is also 4096) → **~187,000 pages**.

| | value |
|---|---|
| page-hash manifest, 8 B/page | ~1.50 MB (downloaded only on cache miss) |
| growth 8.3 MB/day → new pages/day | ~2,030 |
| est. changed pages/day incl. index spine | ~2,600–4,000 |
| **est. per sync @ 8×/day** | ~330–500 pages ≈ **1.3–2 MB raw ≈ 0.4–0.8 MB compressed** |
| **est. per sync @ 1×/day** | ~2,600–4,000 pages ≈ **10–16 MB raw ≈ 3–6 MB compressed** |
| **today** | **153.4 MB compressed, 90–150 s, does not fit a BGAppRefreshTask** |

Improvement: roughly **25×–380×** depending on cadence. For calibration, SQLite's own documentation
for `sqlite3_rsync` reports *"a 500MB database syncs with approximately 20KB of traffic"* for
databases that are already similar ([sqlite.org/rsync.html](https://sqlite.org/rsync.html)) — your
case is worse than that only because you genuinely add ~8 MB/day of new data, which no protocol can
avoid shipping.

**Every row above is an estimate. P0 measures all of them on real data in an afternoon. Do P0 first.**

---

## 3. The market survey

### 3.0 Comparison table

| option | topology fit | iOS/Swift | server | licence / cost | maintenance health | verdict |
|---|---|---|---|---|---|---|
| **`sqlite3_rsync`** (SQLite core) | **exact** — origin→replica, both live, page-level | C file compiles for iOS; needs FFI + non-ssh transport | ships in SQLite; spawn as subprocess | **public domain**, free | **SQLite team**, `tool/sqlite3_rsync.c` on `master` | **Use as oracle; runtime integration too costly** |
| **Litestream** | one-writer→object-store: right shape, wrong host | **no** — Go daemon, no iOS build | perfect for `server.sqlite` | Apache-2.0, free + storage | **excellent** — v0.5.15 (2026-07-21), 14.0k★ | **ADOPT, server-side only** |
| **`liters`** (Rust Litestream) | **exact** — explicitly built for this | UniFFI Swift bindings exist | Rust; needs a sidecar | **NO LICENSE** | 8 commits, 3★, 17 days old, 0 releases | **Watch. Do not depend.** |
| **Graft** | page-level, edge/mobile | Rust + SQLite ext; no Swift binding | self-hostable | Apache-2.0 / MIT | 1.5k★, active — but **"Alpha… contact @carlsverre before using in production"** | No (revisit 2027) |
| **Verneuil** | VFS→S3, one-way | no iOS story | Rust | MIT | 524★, pushed 2026-07-21 | No |
| **LiteFS / LiteFS Cloud** | distributed FUSE, server-side | no | Linux only | Apache-2.0 | **LiteFS Cloud retired 2024-10-15**; OSS repo alive but Fly refocused on Litestream | No |
| **Turso / libSQL** | **inverted** — cloud primary, device replica | `libsql-swift` **53★, last push 2025-07-29** | managed cloud (or self-host) | MIT SDK; cloud $0–$29+/mo | Turso rewriting the engine in Rust; **legacy libSQL SDKs superseded** | No |
| **PowerSync** | **inverted + owns your schema** — requires Postgres/Mongo/MySQL/MSSQL upstream; local tables are JSON-backed views (`ps_data__*`), raw tables **experimental** | real Swift SDK (pure-Swift as of 2026-05) | self-host Open Edition | SDKs Apache-2.0/MIT; **service FSL** | healthy, funded, active | **Disqualified** |
| **ElectricSQL** | **read-path only, Postgres→client** | no first-class Swift | Postgres + Elixir service | Apache-2.0 | 10.3k★, very active | **Disqualified — backwards** |
| **cr-sqlite (Vlcn)** | multi-writer CRDT — solves a problem you don't have | loadable ext ⇒ custom SQLite build | needs the ext in Node | MIT | **last push 2024-10-25 (~21 months)** | No |
| **SQLite session extension** | changesets are logical deltas | symbols present since iOS 11 but **undeclared in `sqlite3.h`**; GRDB has **no support** and won't add it | **`better-sqlite3` has none**; `node:sqlite` has it (RC) | public domain | fine, but see §3.7 | **No — sessions die with the process** |
| **Realm / Atlas Device Sync** | server-authoritative | was excellent | — | — | **EOL 2025-09-30** | Dead |
| **Couchbase Lite + Sync Gateway** | server-authoritative, document model | mature | Sync Gateway | Community license restricted; EE = sales call | healthy | No — replaces the whole store |
| **WatermelonDB** | JS/React Native only | no | your API | MIT | 11.8k★, pushed 2025-08-11 | No |
| **SQLSync** | reducer-based, browser-first | no | Rust | Apache-2.0 | pushed 2025-11; author moved to Graft | No |
| **rqlite / dqlite** | Raft clusters of servers | no | yes | MIT / LGPL-ish | very healthy | No — wrong problem |
| **Ditto** | mesh sync, commercial | yes | commercial | commercial | healthy | No — cost + replaces store |

### 3.1 PowerSync — disqualified twice

Two independent disqualifiers, either sufficient.

**It requires a server-authoritative backend database.** *"syncs between SQLite on the client-side and
Postgres, MongoDB, MySQL or SQL Server on the server-side"* — the sync service replicates *out of*
that database via logical replication / change streams / binlog / CDC. There is no Postgres in
noop-cloud and there is no sensible reason to add one purely so that a sync product can consider your
phone data authoritative-somewhere-else.

**More fundamentally, it owns your local schema.** On the client, PowerSync stores synced data as
schemaless JSON in `ps_data__*` tables and exposes your "tables" as **SQLite views** over that JSON.
There are no real indexes and no foreign keys on those views. A "Raw Tables" feature exists to work
around this and is **explicitly experimental**. NOOP's local store is ~31 hand-written GRDB migrations
with a byte-identical Room twin required by `CLAUDE.md`, living in upstream-shared
`Packages/WhoopStore/` that is *not* `CLOUD_SYNC`-gated. You cannot hand that to PowerSync, and you
cannot fork the schema without breaking the twin rule and upstream compatibility simultaneously.

Could you invert it — use only the write path, with a custom `uploadData` connector pointed at your
Node server? No: the upload queue is populated by writes made *through PowerSync's managed tables*.
There are no such tables. The inversion has nothing to hook into.

Sources: [powersync.com](https://powersync.com/),
[client architecture](https://docs.powersync.com/architecture/client-architecture),
[raw tables (experimental)](https://releases.powersync.com/announcements/introducing-raw-sqlite-tables-support-experimental),
[powersync-swift](https://github.com/powersync-ja/powersync-swift),
[licensing](https://www.powersync.com/blog/new-open-era-for-powersync).

### 3.2 ElectricSQL — backwards, and it says so

Electric today is a **read-path** sync engine: it streams rows *out of* Postgres to clients over HTTP
via "Shapes." *"Electric does read-path sync but does not do write-path sync… you will need to use a
remote API endpoint that inserts, updates or deletes from your Postgres."* The original v1 vision
(two-way active-active Postgres↔SQLite) was cut; the Dart/local-first client is deprecated pending an
undetermined return.

Your data flows 99% phone→server. Electric's supported direction is server→client. It is not a poor
fit; it is the opposite arrow. Healthy project (10.3k★, pushed 2026-07-23, Apache-2.0) — for someone
else.

Sources: [docs/intro](https://electric-sql.com/docs/intro),
[writes guide](https://electric-sql.com/docs/guides/writes),
[repo](https://github.com/electric-sql/electric).

### 3.3 Turso / libSQL — inverted, and the Swift client is stale

Embedded replicas are *"a local SQLite file that syncs with your Turso database"* — the cloud
database is primary, the device is the replica. Offline Writes exist (public beta) and do let a local
replica accept writes, but the model is still "sync up to Turso Cloud," and the local file is managed
by libSQL, not by GRDB. Same schema-ownership problem as PowerSync, plus a vendor and a bill.

Concretely: `tursodatabase/libsql-swift` is **53★, last pushed 2025-07-29 — a year stale**, and Turso
now advises that *"the legacy libSQL SDKs have been replaced by new Turso-native SDKs"* while the
engine itself is being rewritten in Rust (`tursodatabase/turso`, 23.4k★). Betting a health-data
pipeline on a 53-star, year-stale binding into a product mid-rewrite is not a reduction in risk over
writing 500 lines yourself.

Sources: [embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction),
[offline writes](https://turso.tech/blog/introducing-offline-writes-for-turso),
[libsql-swift](https://github.com/tursodatabase/libsql-swift), [turso](https://github.com/tursodatabase/turso).

### 3.4 LiteFS / LiteFS Cloud — verified sunset

**LiteFS Cloud was retired on 2024-10-15.** Fly's own announcement thread is
[community.fly.io/t/sunsetting-litefs-cloud/20829](https://community.fly.io/t/sunsetting-litefs-cloud/20829),
and the docs pages for it are marked deprecated. The open-source LiteFS project is not dead
(`superfly/litefs`, 4.8k★, pushed 2026-05-11) but Fly's investment visibly moved back to Litestream,
which is shipping releases monthly. LiteFS is a FUSE filesystem for Linux clusters regardless — there
was never an iOS story.

### 3.5 cr-sqlite — dormant, and solves a problem you don't have

`vlcn-io/cr-sqlite`: MIT, 3.7k★, **last push 2024-10-25 — roughly 21 months ago**, latest npm
`0.16.3`. Beyond staleness: it is a *runtime-loadable extension*, which on iOS means abandoning the
system SQLite for a custom build; and `crsql_as_crr` **rewrites your tables** into CRDT form with
clock columns and triggers — a schema change in upstream-shared code, forbidden by the same rule that
killed `rowVersion` in `DELTA_SYNC_DESIGN.md` §3. And it buys multi-writer conflict-free merge, which
is worth exactly nothing to a single user with a single phone.

### 3.6 Realm, Couchbase Lite, WatermelonDB, Ditto, rqlite/dqlite — brief

- **Realm / Atlas Device Sync: dead.** MongoDB ended Device Sync and the Atlas Device SDKs on
  **2025-09-30**. The local database survives as OSS without sync. Not an option, and a useful
  reminder about depending on a vendor's sync service.
- **Couchbase Lite + Sync Gateway**: mature and iOS-native, but a *document* database. Adopting it
  means deleting WhoopStore. The Community license is restricted (five-node cap, XDCR now
  EE-only); Enterprise is a sales conversation. Both are disqualifying at "$3/month, out of pocket."
- **WatermelonDB**: JS/React Native. No.
- **Ditto**: commercial mesh sync, replaces the store. No.
- **rqlite / dqlite**: Raft clusters of *servers*. Excellent projects, wrong problem — they make many
  servers agree; you have one server and one phone.

### 3.7 The SQLite session extension — the sleeper answer that doesn't survive iOS

The brief flagged this as possibly the sleeper. It is a genuinely interesting near-miss and it is
worth writing down *why* it fails, because the reasoning is not obvious.

**Availability is fine, better than expected.** Apple's system SQLite has been built with
`SQLITE_ENABLE_SESSION` **and** `SQLITE_ENABLE_PREUPDATE_HOOK` since **iOS 11**
([compile-options diff](https://gist.github.com/zydeco/ea9fe47d2c3f70a29a3cbec5eec13b9f)). The
symbols are in `libsqlite3.dylib`; they are simply **not declared in the public `sqlite3.h`**, so you
must declare them yourself. Working Swift bindings exist ([`sbooth/Pipeline`](https://github.com/sbooth/Pipeline),
[`feistydog/FeistyDB`](https://github.com/feistydog/FeistyDB), both MIT and pushed 2026-06-22).

**GRDB will not help.** groue's position in
[discussion #1523](https://github.com/groue/GRDB.swift/discussions/1523) is that
`sqlite3changeset_apply()` performs changes invisible to GRDB's observation subsystem, that any
support would have to sit behind a build flag given the undeclared status, and that GRDB would
reimplement rather than expose it. **No session support has shipped.** You would use the C API
directly via `db.sqliteConnection`.

**The server half actually works.** `better-sqlite3` — what noop-cloud uses today — has **no**
session/changeset API at all (only `loadExtension` and `backup`). But Node's built-in `node:sqlite`
has the complete surface: `createSession()`, `changeset()`, `patchset()`, `applyChangeset()` with
`filter` and `onConflict`, at **Stability 1.2 (Release Candidate)**
([nodejs.org/api/sqlite](https://nodejs.org/api/sqlite.html)). So the receiving side is free.

**Here is why it still fails.** A session is an **in-memory object attached to an open connection**
that must exist *before* the writes it records. iOS kills your app constantly — mid-BLE-ingest,
mid-background-task, on memory pressure. Any write that happens while no session is attached is
invisible forever, with no way to detect the hole. To fix that you must **durably persist a changeset
at every commit**, which is a change journal — precisely what
`DELTA_SYNC_DESIGN.md` §3 rejected, and it would sit on a 350k-row/day insert path. Worse, it creates
a *second source of truth*: if the journal write fails while the data write succeeds, the row exists
on the phone and can never reach the server, undetectably. That is the exact silent-divergence failure
mode you are trying to eliminate. The one existing package that tries this,
[`gerdemb/SQLiteChangesetSync`](https://github.com/gerdemb/SQLiteChangesetSync) (GRDB-based, a
git-like changeset log), is 57★ and **has not been touched since 2023-12-15**.

Physical replication has the opposite property: the delta is **derived from the data at rest**, so
there is nothing to keep in sync with the data, and a missed window costs one larger diff rather than
permanent loss.

### 3.8 `sqlite3_rsync` — the strongest "buy", and why it's still not the runtime

This is the most important thing this survey found, and it changes how you should think about the
problem even though I am not recommending you link it.

**SQLite ships an rsync for SQLite databases, in core.** `tool/sqlite3_rsync.c`, 76 KB, on `master`.
`sqlite3_rsync ORIGIN REPLICA` makes REPLICA a copy of ORIGIN. Both databases may be live — *"other
programs can write to ORIGIN and can read from REPLICA while this utility runs."* It exchanges page
hashes and ships only mismatching pages: *"a 500MB database syncs with approximately 20KB of
traffic."* WAL-mode and equal-page-size restrictions were **removed in 3.50.0 (2025-05-29)**. The
protocol is a ~6-message stdio exchange between two instances of the same program, one of which is
normally spawned over ssh. Public domain, SQLite-team-maintained.

Read that list against your requirements. It is not merely a good fit — **it is the thing you were
about to write, already written, by the SQLite authors.**

Three concrete obstacles stop it being the runtime, and they are engineering, not conceptual:

1. **Transport.** The tool spawns `ssh host sqlite3_rsync --replica …` and talks over that child's
   stdin/stdout. Your phone cannot ssh to Fly and your server speaks HTTP. Replacing ssh means a
   **bidirectional stream** — a WebSocket or raw TLS socket — because the protocol interleaves
   replica→origin hashes with origin→replica pages, and a plain `POST` is half-duplex. That is a new
   transport in `server.ts` plus `URLSessionWebSocketTask` on the phone.
2. **iOS embedding.** No process spawning on iOS, so you compile the C into the app, run its
   origin-side loop on a thread, and substitute a `socketpair` for the ssh pipes. Bounded, but it is a
   real C-interop project with its own cancellation and lifecycle story.
3. **The two-SQLite hazard, which is the genuinely dangerous one.** POSIX advisory locks are released
   when *any* file descriptor to the file is closed by the process. SQLite works around this with a
   process-global inode table — but only *within one copy of the library*. If `sqlite3_rsync` links
   its own amalgamation while GRDB uses the system `libsqlite3`, you have two independent SQLite
   libraries touching one file in one process, and one can silently drop the other's locks. You would
   have to build `sqlite3_rsync` against the **same** SQLite GRDB uses, or move GRDB to a custom
   SQLite build — the latter touching upstream-shared package dependencies.

Also note the origin side holds a read transaction for the duration of the transfer, which on iOS is
`0xdead10cc` territory if the app suspends mid-sync
([Apple forums](https://developer.apple.com/forums/thread/126438),
[Ashcraft](https://ryanashcraft.com/sqlite-databases-in-app-group-containers/)). The P0–P5 design
avoids this by keeping the *lock* window (the hash pass, seconds) separate from the *transfer* window
(the background upload, no lock held).

**So: use it, just not at runtime.** Install `sqlite3_rsync` on your dev machine and in CI, and make
it the **oracle** for P3's tests: given two fixtures, real `sqlite3_rsync` and your page-apply must
produce identical results. You inherit the SQLite team's correctness reasoning without inheriting
their transport. This is also your emergency repair tool — if the mirror is ever suspect, one
`sqlite3_rsync` run against a pulled phone DB fixes it exactly.

Sources: [sqlite.org/rsync.html](https://sqlite.org/rsync.html),
[protocol writeup](https://nochlin.com/blog/how-the-new-sqlite3_rsync-utility-works),
[source on master](https://github.com/sqlite/sqlite/blob/master/tool/sqlite3_rsync.c).

### 3.9 Litestream and `liters` — right idea, wrong runtime (except server-side)

**Litestream** is in the best shape it has ever been: Apache-2.0, 14.0k★, `v0.5.15` on 2026-07-21,
with the v0.5 rewrite introducing the LTX format (ordered page ranges, CRC-checked, TXID-contiguous,
tiered compaction) and a VFS that lets a reader pull pages from S3 on demand. Its topology —
**one writer, object storage in the middle, read-only replicas downstream** — *is* your topology.

It cannot run on iOS: it is a Go daemon, and its core mechanism (*"a long-running read transaction to
prevent any other process from checkpointing"*) is in direct tension with iOS's suspension rules.
Adopt it **server-side for `server.sqlite`** (P1) and nowhere else. Do **not** point it at the mirror,
which is replaced by `rename(2)`.

**`liters`** ([`mrkurt/liters`](https://github.com/mrkurt/liters)) deserves a paragraph because it is
uncanny: a Rust reimplementation of Litestream's LTX format *"embeddable in iOS/Android apps"*, with
UniFFI Swift bindings, explicit `sleep()`/`resume()` that drops the WAL read lock when the app
backgrounds, offline write queueing, cancellation tokens, and an HTTP **push** mode described as
*"the shape you want when the writer is behind NAT or on a mobile network."* Buckets it writes
*"restore with stock `litestream restore`."* It is, feature for feature, the product this document is
recommending you approximate.

It is also **17 days old, 8 commits, 3 stars, zero releases, and has no LICENSE file** — which means
all rights reserved and you legally cannot vendor it. Written by Kurt Mackey (Fly's founder), so it
may well become real. **Watch it. Consider asking for a license. Do not build on it in 2026.** Its
existence is, however, the strongest possible external validation that page-level replication driven
by explicit push calls sized for `BGTaskScheduler` is the correct architecture for this problem.

### 3.10 Prior art on GitHub — the informative silence

Searches for iOS/GRDB SQLite sync against a self-hosted server return almost nothing on point.
GitHub's repository search finds no results for "sqlite page level sync mobile", "sqlite delta sync
self-hosted offline first ios", "litestream swift", or "GRDB sqlite changeset sync". What does exist
is uniformly **CloudKit-** or **Supabase-**shaped: `aaronpearce/Harmony` (220★, *"CloudKit sync for
GRDB and only GRDB"*), `sitapix/sqlitedata-swift-skills` (Point-Free's SQLiteData + CloudKit),
`happyface-studio/HappySync` (GRDB⇄Supabase, outbox + cursor + LWW). Every one of them syncs to a
*service* with its own data model.

That silence is a finding: **nobody is publishing "my phone is the database of record and my server
is a read-only SQLite replica of it,"** because almost nobody builds that. Your topology is genuinely
unusual — but the unusual part is not "offline-first." It is that you have a *server* whose only job
is to let an AI read a replica of your phone. That is a 2026-shaped requirement and the sync market
has not caught up to it.

The nearest published prior art in spirit is `liters` (§3.9), which is 17 days old.

---

## 4. The strongest argument against this recommendation

Presented as forcefully as I can, because you should be able to weigh it.

> **You are being told to delete a finished design and build a different custom thing, by a document
> whose central quantitative claim is an estimate.**
>
> Everything in §2.4 — the 0.4–6 MB per sync, the 1–3% page churn — is inference from row counts and
> B-tree intuition. **Nobody has ever measured how many pages actually change between two of VK's
> syncs.** If the real number is 20–40% (freelist reuse from `rawBatch` eviction, `PrunePolicy`
> churn, `dailyMetric`/`metricSeries` full-table rewrites on every recompute rippling through
> interior nodes, index page splits), then a page diff is 30–60 MB/sync and **loses outright** to the
> row-level design's 300–500 KB — because the row-level design ships only rows it knows are new,
> whereas a page diff pays for every byte SQLite happened to touch. `MetricsCache.upsertDailyMetrics`
> rewriting all 19 non-key columns on every recompute is exactly the kind of thing that dirties pages
> far out of proportion to the information changed.
>
> Meanwhile `DELTA_SYNC_DESIGN.md` is *not speculative*. It rests on a real schema survey, real row
> counts, real measured growth, and it correctly anticipated hazards a page-diff author would never
> think about (`rrInterval` rowid ordering and RMSSD; `TimestampHeal`'s watermark stall;
> `IntelligenceEngine` re-keying sleep sessions). Its author read the code. It has a cheap stopping
> point — S3 alone, "~95% of the win for ~30% of the work" — which is roughly the same effort as P3+P4
> here.
>
> And there is a strategic point: a page diff **couples you to SQLite's physical file format and to
> whatever GRDB and Apple's `libsqlite3` do to it.** A `PRAGMA auto_vacuum` change, an iOS SQLite
> upgrade that alters page layout or defaults, an incremental-vacuum setting, a future encryption
> layer — any of these silently move you from a 1% diff to a 100% diff, and the failure looks like
> "sync got slow" rather than an error. Row-level deltas are immune: rows are rows.
>
> Finally: **VK's actual problem was not the protocol, and this document admits it.** All three
> data-costing failures were operational. The honest minimal response is P1 + P2 + a bigger volume —
> which he already bought — and then *nothing*, until sync-on-every-wake proves it is worth a protocol
> at all. Building a new protocol because the old one felt too big is how you get a third one.

**My answer to that argument, and why P0 exists.** The measurement objection is correct and decisive,
which is exactly why **P0 is stage one and costs an afternoon.** If page churn comes back above ~10%,
this document is wrong and `DELTA_SYNC_DESIGN.md` S3 is the right plan; the branch point is cheap and
explicit. The format-coupling objection is real and is answered by mechanism, not optimism: a
`pageSize` change or a >40% diff triggers an automatic full `/ingest`, so the degradation is "one
expensive sync," not corruption — and it is *detected*, because the whole-file hash either matches or
it does not. And on "the problem was operational": agreed, which is why P1 and P2 are ahead of every
protocol stage, and why P5 — deleting `zipstream.ts` and the 200 MB-body machinery — is counted as a
deliverable rather than cleanup.

Where the objection lands hardest: **if VK decides "once a day when I open the app is fine," then
P1 + P2 + the 10 GB volume genuinely is the whole answer and P3–P5 should not be built.** That is
`DELTA_SYNC_DESIGN.md`'s open question **Q2** and it is still the single answer that changes the most.
The 153 MB upload works today, on Wi-Fi, when he opens the app. Only the ambition of syncing on every
background wake justifies anything past P2.

---

## 5. Migration path, and effort against the old plan

| | `DELTA_SYNC_DESIGN.md` (S1–S4) | this plan (P0–P5) |
|---|---|---|
| server protocol code | `/sync-state` + `/ingest-delta` + tier-aware merge, ~800 lines | manifest + page-apply, ~300 lines |
| phone protocol code | delta builder, tier logic, chunking, reconcile, ~600+ lines | hash + diff + upload, ~300 lines |
| schema-aware surface | every table, both tiers, both languages | **none** |
| new server dependencies | none | none (Litestream is a sidecar binary) |
| new phone dependencies | none | none |
| prerequisite refactors | `Mirror.rrIntervalsRange` → `ORDER BY ts, seq` (blocking) | none |
| test burden | property test over append/replace orderings; per-tier fixtures | one round-trip property test + **a real `sqlite3_rsync` oracle** |
| calendar estimate | ~4–6 weeks | **~8–11 days** |
| code *deleted* | none — `/ingest` retained in full | `zipstream.ts`, `adm-zip`, staging complexity, size-preflight arithmetic, `contentToken` |

**What carries over from the old design unchanged**, and should be reused verbatim rather than
rewritten:

- §7 **S0** — extend the volume. Done.
- §7 **S0.5** — phone error handling, retry, background session, BGTask identifier fix. This is P2,
  word for word. It was right.
- §4.6 steps 6–10 — `requireSpaceFor`, copy-to-staged, `wal_checkpoint(TRUNCATE)`, remove stale
  `-wal`/`-shm`, `rename(2)`. The merge *mechanics* are identical; only what gets applied changes.
- §5 — the read-consistency argument for copy-then-rename. Unchanged and still the reason the 19 MCP
  call sites need no edits.
- §6 — Tigris recommendations. §6.1 (deep buffers stay), §6.2 (archive full snapshots — P6), §6.3
  (do **not** move the hot mirror to object storage), §6.4 (cold tiering is probably never).
- §9 — the constraints check. Physical delta sync is *even more* clearly "transport, not stored
  data": it changes no stored value, no decoder, no analytic, no migration, and touches
  `Packages/WhoopStore/` not at all. Fork-only, `#if CLOUD_SYNC`, no Kotlin twin.

**What to discard:** §3 (the change-tracking comparison — still correct, now moot), §4.1–4.5 and
§4.7–4.10 (the entire row-level protocol), §7 S1/S2/S3/S4, and open questions **Q3** (eventual
consistency — no longer a trade you have to make), **Q5** (`rrInterval` ordering — no longer
blocking), and **Q6** (`rawBatch` convergence — no longer a protocol problem; still worth excluding
from the *backup* on size grounds, but that is now a plain optimisation).

**Still open and still VK's call:** **Q2** (target cadence — the answer that decides whether P3–P5 get
built at all), **Q4** (archive snapshots to Tigris — yes, P6), **Q7** (retention), **Q8** (who owns
`noop-cloud` next — P0/P1/P3 are server-only and will conflict with in-flight work; land the
streaming branch first).

---

## 6. Sources

**Litestream / LiteFS / LTX**
[benbjohnson/litestream](https://github.com/benbjohnson/litestream) ·
[v0.5.0 writeup](https://fly.io/blog/litestream-v050-is-here/) ·
[how it works](https://litestream.io/how-it-works/) ·
[Litestream VFS](https://fly.io/blog/litestream-vfs/) ·
[Simon Willison on v0.5](https://simonwillison.net/2025/Oct/3/litestream/) ·
[Sunsetting LiteFS Cloud](https://community.fly.io/t/sunsetting-litefs-cloud/20829) ·
[superfly/litefs](https://github.com/superfly/litefs) ·
[mrkurt/liters](https://github.com/mrkurt/liters)

**SQLite core: rsync + sessions**
[sqlite3_rsync docs](https://sqlite.org/rsync.html) ·
[how sqlite3_rsync works](https://nochlin.com/blog/how-the-new-sqlite3_rsync-utility-works) ·
[tool/sqlite3_rsync.c](https://github.com/sqlite/sqlite/blob/master/tool/sqlite3_rsync.c) ·
[session extension intro](https://www.sqlite.org/sessionintro.html) ·
[node:sqlite session API](https://nodejs.org/api/sqlite.html) ·
[GRDB discussion #1523](https://github.com/groue/GRDB.swift/discussions/1523) ·
[gerdemb/SQLiteChangesetSync](https://github.com/gerdemb/SQLiteChangesetSync) ·
[sbooth/Pipeline](https://github.com/sbooth/Pipeline) ·
[iOS SQLite compile options](https://gist.github.com/zydeco/ea9fe47d2c3f70a29a3cbec5eec13b9f) ·
[better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)

**Mobile sync products**
[PowerSync](https://powersync.com/) ·
[PowerSync client architecture](https://docs.powersync.com/architecture/client-architecture) ·
[PowerSync raw tables (experimental)](https://releases.powersync.com/announcements/introducing-raw-sqlite-tables-support-experimental) ·
[powersync-swift](https://github.com/powersync-ja/powersync-swift) ·
[PowerSync licensing](https://www.powersync.com/blog/new-open-era-for-powersync) ·
[ElectricSQL intro](https://electric-sql.com/docs/intro) ·
[ElectricSQL writes](https://electric-sql.com/docs/guides/writes) ·
[electric-sql/electric](https://github.com/electric-sql/electric) ·
[Turso embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction) ·
[Turso offline writes](https://turso.tech/blog/introducing-offline-writes-for-turso) ·
[libsql-swift](https://github.com/tursodatabase/libsql-swift) ·
[tursodatabase/turso](https://github.com/tursodatabase/turso) ·
[vlcn-io/cr-sqlite](https://github.com/vlcn-io/cr-sqlite) ·
[Atlas Device Sync EOL](https://www.mongodb.com/community/forums/t/atlas-device-sync-end-of-life-and-deprecation/296687) ·
[Couchbase community licence](https://www.couchbase.com/community-license-agreement/) ·
[Nozbe/WatermelonDB](https://github.com/Nozbe/WatermelonDB) ·
[orbitinghail/graft](https://github.com/orbitinghail/graft) ·
[orbitinghail/sqlsync](https://github.com/orbitinghail/sqlsync) ·
[backtrace-labs/verneuil](https://github.com/backtrace-labs/verneuil) ·
[rqlite](https://github.com/rqlite/rqlite) ·
[canonical/dqlite](https://github.com/canonical/dqlite)

**iOS constraints**
[0xdead10cc prevention (Apple forums)](https://developer.apple.com/forums/thread/126438) ·
[SQLite in App Group containers — Ryan Ashcraft](https://ryanashcraft.com/sqlite-databases-in-app-group-containers/)

**Prior art surveyed**
[aaronpearce/Harmony](https://github.com/aaronpearce/Harmony) ·
[happyface-studio/HappySync](https://github.com/happyface-studio/HappySync)

Repository metadata (stars, last push, licence, archived status) was read from the GitHub API on
2026-07-27 rather than from README claims.
