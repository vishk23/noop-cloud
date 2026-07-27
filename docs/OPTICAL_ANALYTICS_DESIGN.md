# Optical (R20 / v20) persistence + analytics architecture

**Status:** design, not implemented. No code in this document is meant to be pasted; it specifies
shapes and contracts for the agent that implements it.
**Date:** 2026-07-27
**Scope:** what happens to the WHOOP 5/MG 2,140-byte optical buffer between the strap and an MCP
query, now that `optical-decode-2140/R20_OFFSETS_2026-07-27.md` has pinned the layout.

Every number tagged **[M]** was measured in this session against the real capture or the live server.
Numbers tagged **[E]** are estimates and are labelled as such. Where this document contradicts the
task brief that commissioned it, the contradiction is called out explicitly — three of the brief's
premises are wrong, and two of them change the answer.

---

## 1. Verdict

1. **Decoding happens in the cloud, from the archived objects. Not on the phone.** The phone ships
   bytes and never runs optical DSP. This is decided on re-derivability and on measured evidence that
   the existing on-device decode path already under-delivered by ~10x relative to the raw archive
   (§5), not on battery — battery is a red herring, the decode is arithmetically trivial.

2. **Retaining raw forever is essentially free, and the design should stop treating it as a cost.**
   Deflated raw optical costs **422.9 B per covered second [M]** — only 1.4x more than a decoded,
   re-packed Int32 waveform (302.3 B/s [M]). There is no storage argument for discarding raw, because
   discarding it saves 28% of nothing. VK's instinct is quantitatively correct.

3. **The phone's problem is not the 50 MB cap in the brief — that cap governs a different table.**
   The deep-buffer log has its own budget (60 MB live + 60 MB rotated). The real problem is that the
   log stores **hex JSONL, so it is 2.06x larger than binary [M]**, and it is stored **uncompressed**
   while the uploader compresses only at send time. Fixing that one asymmetry — compress at write,
   in 256 KB frames — buys **4.36x [M]** at a cost of 0.9% compression ratio, and converts the
   capture policy question from "impossible" to "comfortable".

4. **Capture policy: sleep-window nightly (~8 h), not 24/7 — but only because of what the data is
   worth, not because 24/7 is unaffordable.** After the compress-on-write fix, 24/7 is affordable
   too (§4.4). The reason to start with the sleep window is that the pulse **dies above ~90 bpm and
   is wrist-motion limited [M, from the decode doc: ≤6.9% within 6 bpm on non-resting windows]**, so
   waking hours produce mostly unusable optical data at full price. Sleep is where this signal
   is valid. Ship sleep-window first; the switch to 24/7 is one constant.

5. **The single biggest risk is not storage. It is that the log destroys its own data on rotation,
   and today's phone→cloud lane cannot keep up with 24/7 capture.** See §9.1.

---

## 2. What already exists — verified, not assumed

Every item in the brief was checked. Results:

| Brief claim | Verified? | Finding |
|---|---|---|
| Capture → upload → object storage → manifest works | **Yes** | One session, `deep_buffer_coverage` on the live server |
| 29,699 optical + 29,701 IMU, 200.7 MB raw → 44.8 MB stored, ratio 4.48 | **Yes [M]** | Live: `rawBytes` 210,402,099, `storedBytes` 46,941,192, ratio 4.482, 13 chunks, 2 generations |
| Ran once, not continuous | **Yes** | `dataExtent` is exactly the one session; nothing since 2026-07-15 |
| On-device retention: `PrunePolicy` 24 h / 50 MB | **Yes, but it does not apply here** | `Database.swift:587`: "`PrunePolicy`'s ~50 MB cap governs ONLY `rawBatch`". The deep-buffer log is a separate file with a **60 MB soft cap + one rotated generation** (`PuffinDeepBufferLog.softCapBytes`) |
| `rawBatch: 0 rows` | **Yes** | Confirmed via `streams` |
| R20 layout pinned, 54/54 assertions, 29,203 records | **Yes** | Read in full; §(b) lists **9 items still unpinned** — load-bearing for §5 |
| `@82` / PR #848 is the pattern for on-device wiring | **Yes** | And `ppgWaveformSample` (migration `v27-ppg-waveform`) is a closer precedent — a per-second PPG **waveform** table already exists on device |
| fly volume "10.5 GB (not where bulk goes)" | **Yes [M]** | Live: 10,533,376,000 B total, 9,294,585,856 B free, mirror 782,413,824 B |
| PR #889 schema-parity oracle over 31 tables | **Yes — and it currently cannot gate a fork-side table** | Lives on `test/schema-parity-oracle`, branched from a clean upstream tree. Fork `main` has **36** migrations with duplicated ordinals, so one of the oracle's own structural tests fails before it ever inspects a new table. See §6.4 — this is a rollout blocker, not a detail |

### 2.1 Three corrections that change the design

**(a) The 50 MB cap is the wrong number.** The brief's arithmetic ("292 MB/day against a 50 MB
on-device cap") uses a cap that governs `rawBatch`, a table with **0 rows**. The deep-buffer log's
real budget is 120 MB across two generations. This makes the situation *less* dire than the brief
assumed — but only slightly, because of (b).

**(b) The brief's 3,384 B/s is the binary size. The phone writes hex.** Measured on the real file:

| | binary | on disk (hex JSONL) | expansion |
|---|---|---|---|
| optical (2140 B) | 2,140.0 B | **4,408.0 B [M]** | 2.06x |
| IMU (1244 B) | 1,244.0 B | **2,676.6 B [M]** | 2.15x |
| **per covered second** | 3,384 B | **7,084.6 B [M]** | **2.09x** |

So the real uncompressed on-device rate is **612.1 MB/day**, not 292 MB/day — the brief understates
the phone-side problem by 2.09x. (The 2.15x on IMU exceeds 2.0x because ~1/3 of IMU lines also carry
an inline decoded feature summary, ~280 B each [M].)

**(c) Coverage was not 100%, and the shortfall is one event, not attrition.** The session reports
29,699 optical buffers over a 49,380 s span — 60% — which reads like sustained sample loss. It is
not. Measured on the local corpus: **29,200 distinct `strap_ts`, 14 gaps, and a single 19,609 s
(5.45 h) gap accounts for 97.2% of all missing seconds [M]**. The other 13 gaps total 571 s, twelve
of them exactly 1 second. **Within a run, banking is essentially perfect (99.96%).** The failure mode
is whole-session dropout, not sample loss — which means capture policy should be reasoned about in
units of *sessions*, not sampling density.

---

## 3. The storage arithmetic

### 3.1 Compression, measured properly

The live server reports 4.482x. That number is a **blend of two very different streams**, and the
blend is what has been hiding the most useful fact in this pipeline. Compressed at production's
16 MB chunk size, per stream [M]:

| stream | on disk | deflated | ratio | share of archive |
|---|---|---|---|---|
| optical (2140 B) | 4,408.0 B/s | **422.9 B/s** | **10.42x** | **28.4%** |
| IMU (1244 B) | 2,676.6 B/s | **1,065.9 B/s** | **2.51x** | **71.6%** |
| combined, segregated | 7,084.6 B/s | 1,488.8 B/s | 4.76x | |
| combined, interleaved (**today**) | 7,084.6 B/s | 1,568.5 B/s | **4.517x [M]** | |

The interleaved figure reproduces the live server's 4.482x to within 0.8%, which validates the
method. The optical record compresses 10.4x because it is mostly structural zeros: two of five
blocks are entirely zero, bytes 100–199 of every 200-byte reading slot are zero, and the high byte
of every Int32 is zero because the values are 20-bit — roughly **72% of the record is zero by
construction**, which follows directly from the R20 map.

**Consequence: the IMU stream, not the optical stream, is 72% of the archive's cost.** Any
conversation about "the optical data is too big" is misdirected. Optical at 24/7 is 36.5 MB/day.

### 3.2 Is raw worth keeping? Yes — decisively

Decoding the 29,203-record corpus into its actual signal content (3 active blocks x 2 slots x
25 samples/s = 150 Int32/s) and re-compressing [M]:

| representation | B per covered second | deflated |
|---|---|---|
| on-disk JSONL hex (today) | 4,408.0 | 422.9 |
| raw binary | 2,140.0 | — |
| decoded Int32 (6 ch x 25 Hz) | 600.0 | 302.3 |
| decoded Int16 (>>4, lossy) | 300.0 | 170.7 |

**Keeping the full raw record forever costs 1.40x what keeping only a decoded Int32 waveform would
cost** (422.9 vs 302.3 B/s). For a 40% premium you keep every unpinned field, every configuration
byte, the CRC, and the ability to re-decode when the 9 open items in §(b) of the decode doc get
resolved. This is not a close call. **Never discard raw** is not just VK's policy here; it is also
the cheap option.

### 3.3 Daily and annual volume

At the measured rates, per day of *covered* capture:

| policy | on disk (phone) | uploaded/stored | per year |
|---|---|---|---|
| 24/7, both streams | 612.1 MB | 128.6 MB | **46.9 GB** |
| 24/7, optical only | 380.8 MB | 36.5 MB | **13.3 GB** |
| 8 h sleep window, both | 204.0 MB | 42.9 MB | **15.7 GB** |
| 8 h sleep window, optical only | 126.9 MB | 12.2 MB | **4.4 GB** |

At commodity object-storage pricing (~$0.02/GB-month [E]), the most expensive of these — 24/7 both
streams — costs about **$0.94/month at the end of year one and ~$4.70/month after five years [E]**.
Storage cost is not a design constraint at this scale. It should not be allowed to shape the policy.

### 3.4 The phone is the bottleneck, and the fix is one asymmetry

Today the phone writes **uncompressed** hex to disk and compresses **only at upload**. That is
backwards: the compression is available for free at write time, and the phone's scarce resource is
disk, not CPU.

Measured: compressing in fixed frames rather than as one stream costs almost nothing [M]:

| frame size | ratio | B per covered second | % of whole-file ratio |
|---|---|---|---|
| per line | 3.67x | 1,912 | 83.4% |
| 16 KB | 4.06x | 1,731 | 92.3% |
| 64 KB | 4.27x | 1,646 | 97.0% |
| **256 KB** | **4.36x** | **1,611** | **99.1%** |
| 1 MB | 4.39x | 1,601 | 99.8% |
| whole file | 4.40x | 1,598 | 100% |

**256 KB frames retain 99.1% of the achievable ratio.** So compress-on-write in 256 KB frames is a
4.36x reduction in on-device footprint for a 0.9% ratio penalty.

What that does to the numbers that matter:

(The soft cap in `PuffinDeepBufferLog` is `60 * 1024 * 1024` = 62.9 MB, and rotation keeps one
previous generation, so the *guaranteed* retention is one full generation and the best case is two.)

| | today | compress-on-write (256 KB frames) |
|---|---|---|
| on-disk rate | 7,084.6 B/s | 1,611 B/s |
| guaranteed retention (1 generation, 62.9 MB) | **2.47 h** | **10.8 h** |
| best case (2 generations, 125.8 MB) | **4.93 h** | **21.7 h** |
| full drains needed per day at 24/7 | **4.8** | **~1.1** |
| an 8 h night occupies | 204 MB — **3.2 rotations** | 46.4 MB — **fits in one generation** |

That last row is the whole argument. **Today, a single 8-hour night does not fit in the log's own
retention budget.** It rotates ~3.2 times, and each rotation destroys a generation permanently.
Capturing a full night today *requires* successful mid-night background drains, or data is lost with
no error anywhere. After compress-on-write, a night fits inside one generation with 26% headroom,
and the drain becomes an optimisation rather than a correctness requirement.

Secondary benefit: the uploader stops re-compressing. It becomes a pure byte-range copy of already
compressed frames, so the CPU cost of a drain drops to ~zero and far more of the ~30 s
`BGAppRefreshTask` budget goes to network.

### 3.5 Offline survival

With compress-on-write and the existing 62.9 MB soft cap, surviving with **no successful drain at
all** (guaranteed floor / best case):

| policy | guaranteed | best case |
|---|---|---|
| 24/7, both streams | 10.8 h | 21.7 h |
| 8 h night, both | **1.4 nights** | 2.7 nights |
| 8 h night, optical only | 5.2 nights | 10.3 nights |

Raising the soft cap to 256 MB ([E] a modest fraction of the phone's free space; 512 MB worst case
across two generations) takes sleep-window survival to **5.8 nights guaranteed, 11.6 best case**.
That is the recommended setting: it makes a weekend with no connectivity, an exhausted
background-refresh budget, or a week of iOS declining to wake the app a non-event rather than a data
loss.

---

## 4. Capture policy — recommendation

**Recommended: nightly sleep-window capture of both streams, with compress-on-write, a 256 MB log
budget, and a drain attempt on every foreground app open plus every background wake.**

### 4.1 Why sleep-window rather than 24/7

Not cost. The decode doc's own validation is the reason: on **resting** windows (reference HR
45–75 bpm) block-0 `pdAReadings` achieves 2.48 bpm median error and 63.6% within 6 bpm; on
**non-resting** windows (85–130 bpm) **every stream fails, ≤6.9% within 6 bpm [M]**. The pulse is
wrist-motion limited. Waking-hours optical data is, for now, mostly a record of motion artifact
bought at full storage and battery price.

Sleep is also where the downstream value is: the open scoring problems in this project are sleep
staging, wake detection, and the recurring mis-score caused by HR-led wake detection. Optical
features that discriminate sleep states are directly useful; daytime PPG is not, yet.

### 4.2 Why not optical-only

Tempting — it is 3.5x cheaper. But the IMU stream is the **negative control** for every optical
claim. The decode doc's own honest note is that the pulse "dies above ~90 bpm and is wrist-motion
limited"; distinguishing "no pulse because asleep and still" from "no pulse because the wrist moved"
requires synchronous motion. Discarding IMU to save 92 MB/day would make the optical data
substantially harder to trust, which is exactly the failure that got PPG→HR (#194) withdrawn. Keep
both. Revisit only if storage ever actually binds, which §3.3 says it will not.

### 4.3 Window definition

Capture from **30 minutes before the user's typical bedtime to 30 minutes after typical wake**,
derived from the existing sleep history rather than a fixed clock — VK travels PT↔ET and a fixed
UTC or fixed-offset window would drift off the night. Fall back to a generous fixed local window
(21:00–09:00 local, 12 h = 64 MB/night compressed) when there is no history. The capture toggle
stays a user-visible setting; this is a default, not a lock.

### 4.4 When to go 24/7

Flip to continuous when **either** (a) a validated feature is shown to work on non-resting data, or
(b) a specific research question needs daytime data (e.g. the `ir_hw_switching` phase protocol in
§(c) of the decode doc, which explicitly wants matched worn-at-rest phases and is easier to run
awake). After compress-on-write, 24/7 costs 135 MB/day uploaded and ~1.1 drains/day — affordable.
It is a constant, not a redesign.

### 4.5 Failure behaviour, explicitly

- **No connectivity for a day:** nothing is lost. 8 h night = 46.4 MB compressed against a 512 MB
  budget; ~6 nights of slack. The watermark simply does not advance.
- **App backgrounded / jetsammed:** capture stops, because capture only happens while connected to
  the strap and processing an offload burst. **The strap is the real primary buffer** — it banks
  internally and replays on connect. Measured evidence: the observed session's buffers arrived over
  **27.6 h of wall clock while covering only 13.7 h of strap time [M]**, and arrived in bursts
  (29,203 records across just 5,596 distinct arrival seconds [M], ~5.2 records/s). So a jetsam
  costs nothing as long as the app reconnects before the strap's own ack-trim frees the backlog.
  This is the single most under-appreciated property of the pipeline and it is what makes
  duty-cycled capture safe.
- **Drain never runs:** bounded loss at the oldest end, and only after the budget fills (§3.5). The
  drain is already correctly ungated (`CloudSyncModel.drainDeepBuffers` runs on every sync, outside
  the do/catch, deliberately not gated on the rest of the sync succeeding). Keep that.

---

## 5. Where decoding happens

**Cloud-side, from the archived objects. The phone never decodes optical.**

### 5.1 The argument

**(a) Re-derivability is the whole point, and the decode is one day old.** §(b) of the decode doc
lists nine unpinned items, including the semantics of `ledA`/`ledB`, the meaning of the
`ledASource`/`ledBSource` enum, the units of `pdARange`, and — critically — **any wavelength claim
at all**. A prior wavelength claim (R5=IR/R6=red) was already retracted once. Freezing this decode
into a shipped on-device schema now would mean re-shipping the app to both platforms every time one
of those nine items resolves. Cloud-side, a re-decode is a job run over objects that never moved.

**(b) There is measured evidence the on-device path under-delivers.** The IMU stream already does
on-device decode (`ImuActivityIngest`, commits `aa7ea981`/`42642f20`). Result on the live server:

- raw archive holds **29,701 IMU buffers** across a 13.7 h session [M]
- **10,201** of them carry an inline decoded summary [M]
- `imuActivity` holds **2,945 rows**, spanning **58 minutes** [M]

The raw archive retained ~10x more than the derived on-device table did. Whatever the cause —
backfill window, interrupted run, jetsam — **the archive was complete where the derived table was
not.** That is the empirical case for deriving from the archive rather than at the edge. (Stated
carefully: this shows the on-device path *did* under-deliver on this session; it does not prove it
must. But it is the only evidence available, and it points one way.)

**(c) Battery is not the reason, and the design should not claim it is.** Decoding R20 is parsing
2,140 bytes and extracting 150 Int32 per second — microseconds. The honest reasons are (a) and (b).
Overstating the battery argument would be the kind of thing that gets caught in review.

**(d) The phone is a transient outbox by VK's own constraint.** Persisting derived optical features
on device contradicts "I don't want to waste my phone storage" unless they are tiny — and if they
are tiny, they can just as well be computed in the cloud and synced back if ever needed for UI.

**(e) The cross-platform tax is asymmetric and large — and currently blocked.** An on-device table
needs a GRDB migration, a Room twin with matching column order, seven Swift registration sites, a
`ContentToken` segment, entries in both byte-identical copies of the oracle fixture — and, first,
a resolution of the fork's migration-ordinal collision that makes the oracle fail before it even
inspects the new table (§6.4). Cloud-side needs one `CREATE TABLE IF NOT EXISTS` in
`server.sqlite`. Per iteration of a feature set that is **explicitly not yet designed** — the
prior-art document does not exist yet, verified — that difference dominates everything else in this
decision.

Note the shape of the evidence in (b) and (e) together: the IMU precedent went on-device, and it
both under-delivered its rows *and* shipped without a Room twin, without an oracle entry, and with a
`ContentToken` bug that had to be fixed in a follow-up commit (`58a6714b`) before its data could
reach the cloud at all. That is not an argument that the people involved were careless; it is an
argument that the on-device path has a long tail of obligations that is easy to underestimate.

### 5.2 The cost of choosing cloud, stated honestly

Features are **not available offline and not available immediately** — they appear after the next
successful upload plus a decode run. For sleep analytics consumed the next morning this is
acceptable. If a feature ever needs to drive live UI, §8 Stage 5 is the escape hatch: promote one
validated feature to on-device computation, paying the parity tax once, for a feature that has
earned it.

### 5.3 Where the decode runs, mechanically

There is **no background job runner on the server** — verified: no `setInterval`, no cron, no
worker; everything is request-scoped, and the single machine has `auto_stop_machines = "stop"` with
`min_machines_running = 1`. Three options, in order of preference:

1. **An authenticated `POST /decode` endpoint driven by the existing GitHub Actions cron.** The repo
   already has `.github/workflows/morning-report.yml` on a daily schedule that calls the deployed
   server; this is a proven pattern in this codebase and needs no new infrastructure. Range-bounded
   and resumable so one invocation is a bounded unit of work.
2. Piggy-back on `POST /deepbuf` ingest, decoding just the chunk that arrived.
3. A real in-process timer — **not recommended**: a long decode blocks the single Node thread, and
   there is precedent (`measurePageChurn`, a 36 s cold walk that had to be explicitly reasoned about
   because "Node's one thread owes `/healthz` an answer meanwhile").

Option 1 with option 2 as an opportunistic accelerator is the recommendation. Every decode run must
be **idempotent and range-keyed**, so a re-run is free and a partial run resumes.

---

## 6. Schema

### 6.1 The hard constraint that shapes everything

**The mirror is read-only and replaced wholesale on every phone sync** (`new Database(path, {
readonly: true, fileMustExist: true })`; ingest does an atomic `fs.renameSync(staged,
cfg.mirrorPath)`). Any row the server writes into `mirror.sqlite` is destroyed at the next upload.
Server-derived data **must** live in `server.sqlite`, which is opened writable, uses
`CREATE TABLE IF NOT EXISTS`, and already has the guarded `PRAGMA table_info` + `ALTER TABLE ADD
COLUMN` idiom for evolving in place.

The proven precedent is the edit system: durable rows in `server.sqlite`, replayed as an overlay
onto the immutable mirror at read time. Optical analytics follow the same shape.

### 6.2 Three storage tiers

| tier | what | where | volume at 8 h/night | deletable? |
|---|---|---|---|---|
| **0 — raw** | the 2,140 B records as captured | object storage, `deepbuf/v1/...` (**exists**) | 42.9 MB/night | **never** |
| **1 — decoded waveform** | 6 channels x 25 Hz Int32, columnar, deflated | object storage, `optical/v1/{decoderVersion}/...` | ~8.7 MB/night [M] | yes — regenerable from tier 0 |
| **2 — epoch features** | 30 s aggregates + config timeline | `server.sqlite` | ~200 KB/night [E] | yes — regenerable from tier 1 |

Tier 1 exists so that feature iteration does not re-inflate and re-parse tier 0 every time. It is a
cache with a version in its key, so a decoder change writes a new prefix instead of mutating
anything. **Only tier 2 is queried by MCP directly; tier 1 is handed out as signed URLs.**

Why tier 1 is not in SQLite: at 600 B/s a decoded waveform is 51.8 MB/day, i.e. **18.9 GB/year** —
against a 10.53 GB volume that already holds a 782 MB mirror plus a same-size staged copy during
ingest. It does not fit and must not be allowed to try.

### 6.3 Cloud tables (`server.sqlite`)

All names and semantics below use the **neutral vocabulary** from §(d) of the decode doc
(`sampleCount`, `emitterASelect`, `emitterADrive`, `detectorAConfig`, `detectorARange`,
`detectorAOffset`, `detectorAReadings`). The IPA-derived names must not appear in any repository,
commit, issue, or PR.

**`opticalDecodeRun`** — provenance. Makes every derived row attributable and every re-derivation
comparable.

```
id              INTEGER PRIMARY KEY AUTOINCREMENT
decoderVersion  TEXT NOT NULL      -- e.g. 'r20.2026-07-27'
featureSetVersion TEXT NOT NULL    -- e.g. 'fs0' (config only), 'fs1', ...
fromStrapTs     INTEGER NOT NULL
toStrapTs       INTEGER NOT NULL
startedAt       INTEGER NOT NULL
finishedAt      INTEGER
status          TEXT NOT NULL CHECK (status IN ('running','ok','failed'))
recordsIn       INTEGER
recordsDecoded  INTEGER
crcFailures     INTEGER            -- CRC32 over rec[8:2136]; must be 0
schemaViolations INTEGER           -- assertions from r20_validate.py that did not hold
error           TEXT
UNIQUE (decoderVersion, featureSetVersion, fromStrapTs, toStrapTs)
```

`crcFailures` and `schemaViolations` are the honesty columns: the decode doc's 54 assertions held on
29,203/29,203 records, and any future record that violates them is a firmware change or a decode
bug. Counting them makes that visible instead of silent.

**`opticalConfigSegment`** — run-length-encoded AFE configuration. This exploits a measured property:
block-0 `emitterADrive` changed only **13 times in 29,203 records, median hold 423 records [M]**, and
every other configuration field was **constant across all 29,203 records [M]**. RLE collapses a
13.7 h session to a few dozen rows.

```
startStrapTs    INTEGER NOT NULL
endStrapTs      INTEGER NOT NULL
deviceId        TEXT
block           INTEGER NOT NULL   -- 0..4
decoderVersion  TEXT NOT NULL
sampleCount     INTEGER NOT NULL   -- 25 or 0 (block enabled/disabled)
emitterASelect  INTEGER, emitterADrive INTEGER
emitterBSelect  INTEGER, emitterBDrive INTEGER
detectorAConfig INTEGER, detectorARange INTEGER, detectorAOffset INTEGER
detectorBConfig INTEGER, detectorBRange INTEGER, detectorBOffset INTEGER
PRIMARY KEY (startStrapTs, block, decoderVersion)
```
Index on `(endStrapTs, startStrapTs)` for overlap queries, matching `deepBufferChunk_strap`.

**Why columns here and not a packed blob** — the codebase has an explicit rule for this choice
(`V18Aux.swift`): *pick columns if anything will ever `WHERE` on the field; pick a blob if a census
reads whole rows.* The entire purpose of this table is to ask "did `emitterASelect` on block 1
change between phase A and phase B" — a `WHERE` on individual fields. Columns. Conversely, if a
future per-second raw-sample table is ever needed, the `v18AuxSample` presence-bitmap blob is the
right shape and should be copied rather than reinvented.

This table is **immediately valuable with no feature science whatsoever**: it is the readout for the
`ir_hw_switching` experiment protocol in §(c) of the decode doc, which needs exactly "the full
15-field configuration of all five blocks" per phase, and which specifically warns that a phase
shorter than ~500 records cannot be distinguished from ordinary drift. A queryable config timeline
turns that protocol from a manual script into a question you can ask.

**`opticalEpoch`** — the feature table, deliberately **feature-agnostic**. The prior-art document
does not exist yet (checked), so this must not hard-code a feature list.

```
strapTs           INTEGER NOT NULL   -- epoch start, strap clock
epochS            INTEGER NOT NULL   -- epoch length, 30
featureSetVersion TEXT NOT NULL
decoderVersion    TEXT NOT NULL
deviceId          TEXT
coveredSeconds    INTEGER NOT NULL   -- of epochS, how many had a record (never assume full)
activeBlocks      INTEGER NOT NULL   -- bitmask of blocks with sampleCount>0
saturatedFraction REAL               -- share of samples at +2^19-1 (1.57% baseline [M])
featuresJSON      TEXT NOT NULL      -- {key: value} for this featureSetVersion
PRIMARY KEY (strapTs, epochS, featureSetVersion)
```

Extension rule: a new feature is a new key inside `featuresJSON` and a bumped `featureSetVersion` —
**no migration**. A feature that becomes hot enough to filter or sort on gets *promoted* to a real
nullable column via the existing guarded `ALTER TABLE ADD COLUMN` idiom, and the reader prefers the
column when present. This gives extensibility without unbounded EAV row counts: one row per 30 s
epoch is 2,880 rows/day (~200 MB/year at [E] ~190 B/row), versus ~57,600 rows/day for a naive
key-per-row design.

`coveredSeconds` is not optional bookkeeping. §2.1(c) showed coverage is bimodal — near-perfect
inside a run, entirely absent outside one. A feature computed over an epoch with 3 covered seconds
must not be silently indistinguishable from one computed over 30.

### 6.4 On-device schema — and why the answer is "none"

**Nothing lands on device in stages 0–4.** That is a deliberate design output, not an omission. It
means zero GRDB migrations, zero Room twins, and zero exposure to the PR #889 schema-parity oracle
for the entire core of this work — which matters far more than it first appears, because:

**The oracle currently cannot gate a fork-side table at all.** It lives on
`test/schema-parity-oracle`, branched from a clean upstream-shaped tree pinning **31 tables** and
**31 GRDB migration identifiers**. Fork `main` registers **36**, including four fork-local
duplicates of upstream ordinals (`v26-cloud-tombstone` / `v26-efficiency-heal`,
`v27-apple-step-hour` / `v27-ppg-waveform`, `v28-phone-timezone` / `v28-raw-imu`,
`v29-daily-avg-sdnn` / `v29-score-input-provenance`). The oracle's
`testGrdbMigrationIdentifiersAreUniqueAndSequential` requires every `vN` prefix to be exactly
`1...N` with no gaps or repeats, so **it fails on fork main before it ever looks at a new table** —
and `Database.swift` documents why renumbering is unsafe on the fork (a renamed identifier reads as
un-applied on a device that already ran it, so the migrator wedges on `CREATE TABLE … already
exists`).

Three tables that already exist on the fork — `phoneTimezone`, `appleStepHour`, and **`imuActivity`,
the closest precedent for this work** — are absent from the oracle's 31. `imuActivity` has **no
Kotlin Room twin at all**; its own migration comment concedes "Android Room twin deferred
(Swift-only contributor)."

So the honest position is: **adding an on-device table today means first reconciling the fork's
migration ordinals with the oracle, which is a separate piece of work with real device-migration
risk.** Designing this feature to require none of that is worth a great deal, and is a large part of
why §5 lands where it does.

**If Stage 5 is ever triggered**, the minimal addition copies `ppgWaveformSample`
(`v27-ppg-waveform`) — per-second rows keyed `(deviceId, ts)` with a compact BLOB rather than
scalar-per-sample rows. The full cost, from the two precedents, is **not** one migration:

- *Swift:* migration in `Database.swift` → row struct + store file → insert call site →
  `DeviceRegistryStore.deviceScopedTables` → `TimestampHeal` table list →
  `LocalAccessCore.storageStats()` `decodedTables` → **a `ContentToken.swift` segment** → tests.
- *Kotlin:* entity (field order == GRDB column order) → `MIGRATION_25_26` with the SQL split out as
  a `List<String>` so a plain-JVM test can assert it → `@Database` entity list + version bump →
  `.addMigrations(...)` → DAO insert/prune/read → repository call site → retention constant.
- *Both:* the table added to **both byte-identical copies** of `schema_oracle.json`, columns in
  canonical GRDB order with affinity/notNull/default, plus `primaryKey` and `indices`.

**The `ContentToken` step is the one that silently breaks things if forgotten.** `contentToken()` is
the fingerprint that lets `performSync` skip re-exporting an unchanged 100–300 MB `.noopbak`. A
table that is the *only* thing to change fingerprints as unchanged, and its rows **never reach the
cloud, forever**. This exact bug was found and fixed for `imuActivity` in commit `58a6714b`. Note
the deep-buffer lane is immune — it is a separate `POST /deepbuf` drain with its own watermark, not
part of the `.noopbak` upload — which is another reason to keep optical on that lane.

Two oracle quirks worth designing around rather than discovering: a Kotlin constructor default never
reaches the schema (only `@ColumnInfo(defaultValue = …)` does), and a single-column TEXT primary key
is left NULLable by GRDB but `NOT NULL` by Room. Composite `t.primaryKey([...])` avoids the second
entirely — which is why every per-sample table uses one.

---

## 7. The reader / MCP surface

VK's rule: a capture path and a reader ship together. Four tools, following the established
coverage / series / window idiom exactly, all registered **above** the `scope !== "public"` gate in
`src/tools/index.ts` since all are read-only.

**`optical_coverage`** — *where decoded optical exists, and at what version.* The complement to
`deep_buffer_coverage`, which answers where the **raw** exists. Manifest/`server.sqlite` only, no
object fetches. Returns contiguous sessions with `decodedSeconds` vs `rawSeconds` per session, the
`decoderVersion`/`featureSetVersion` present, and the `crcFailures`/`schemaViolations` counts from
`opticalDecodeRun`. **The diagnostic it exists to serve: raw present but decoded absent means a
decode run is owed; decoded present at an old `decoderVersion` means a re-derivation is owed.**

**`optical_config_segments`** — *the AFE configuration timeline.* Reads `opticalConfigSegment`.
Input: `from`, `to`, optional `block`. Output: one row per segment with all 11 configuration fields
plus duration in seconds and records. Generous span limit (366 days, like `imu_coverage`) because
the output is RLE and therefore tiny. This is the tool that makes the §(c) experiment answerable,
and it is shippable before any feature exists.

**`optical_series`** — *epoch features over a window.* Reads `opticalEpoch`. Mirrors `imu_series`
exactly: 7-day `MAX_SPAN_S`, `bucketSeconds` default 300 clamped [60, 3600], `SERIES_CAP` on the
read, `truncated: true` + a hint when the cap is hit, `notCaptured` + hint when the table is absent.
Emits promoted columns plus the union of `featuresJSON` keys, with `coveredSeconds` carried through
so a caller can weight or reject sparse epochs. Optional `featureSetVersion` argument defaulting to
the latest, so two feature-set generations can be compared over the same window — the point of the
whole re-derivation design.

**`optical_window`** — *narrow window, per-second detail and handles to the bytes.* Max 1 h span
(vs `deep_buffer_window`'s 6 h, because optical detail is denser). Returns per-second per-channel
summaries and, crucially, an `objects` array of **1-hour signed URLs to the tier-1 decoded
waveforms**, following the existing discipline stated in `deep_buffer_window`: *summaries and
handles through MCP, bytes out-of-band*. Never streams waveform samples inline — 150 Int32/s over an
hour is 540,000 values and useless in a context window.

### 7.1 A governance bug found while specifying this

The `streams` tool is supposed to surface capture-without-a-reader as `gaps`. Live, it returns
`"gaps": []` and `"note": "every populated biometric stream has a reader"` — but the same response
lists **three populated tables with `readBy: null`**:

- `ppgWaveformSample` — **36,379 rows**, no reader, no note
- `v18AuxSample` — **1,598 rows**, no reader, no note
- `ppgHrSample` — 36,589 rows, no reader (this one is *deliberate* and carries an explanatory note)

So the instrument that enforces VK's "a capture path and a reader ship together" rule is currently
reporting all-clear while two streams sit unread. `ppgWaveformSample` is especially pointed: it is
**per-second PPG waveform data already on the phone and already synced to the cloud**, closely
related to this design, and nothing can query it.

This should be fixed **before** this design ships, otherwise `opticalEpoch` will be the fourth
silently-unread stream. Suggested: `gaps` should include any table with rows > 0 and `readBy` null
unless it carries an explicit `note` justifying it. Filed as a Stage 0 item in §8.

---

## 8. Staged rollout

Each stage is independently shippable and independently valuable. No stage requires the next one to
have been designed.

### Stage 0 — Fix the reader-gap oracle, and prove the lane still works
*Cloud only. No schema. Hours.*
- Fix `streams.gaps` (§7.1) so unread streams are visible.
- Add a reader for `ppgWaveformSample`, or an explicit note if it is intentionally unread.
- Run one more overnight capture on the current pipeline and confirm it lands.
**Value:** the governance rule starts working again, and an existing unread stream gets a reader.
**Ships without touching the phone.**

### Stage 1 — Compress-on-write + segregate by kind
*Phone only. The highest-leverage change in this document.*
- `PuffinDeepBufferLog` writes 256 KB deflate frames instead of plain lines; a small framed-container
  header so the file is still self-describing and resumable at frame boundaries.
- Separate the two buffer families into separate logs (recovers the 10.42x / 2.51x ratios instead of
  the blended 4.52x, and makes optical-only policy possible later).
- Uploader ships stored bytes verbatim; the server's `parseChunkStats` learns the frame container.
- Raise the soft cap to 256 MB.
**Value:** 4.36x less phone storage; a full night fits in one generation; drains needed drop from 4.8
to ~1.1/day; upload CPU → ~0. **Valuable even if no decode ever ships.**
**Risk:** this touches `PuffinDeepBufferLog`, which is upstream-safe and deliberately knows nothing
about upload. The format change must stay inside the capture/uploader contract and must not import
anything from `Strand/CloudSync/`. Version the container header so old generations still drain.

### Stage 2 — Cloud decoder + tier 1 + config timeline
*Cloud only. No feature science required.*
- Port `r20_validate.py`'s 54 assertions into the server decoder as a **gate**, not a comment.
- `POST /decode` (authenticated, range-bounded, idempotent), driven by the existing Actions cron.
- Write tier-1 waveform artifacts, `opticalDecodeRun`, `opticalConfigSegment`.
- Ship `optical_coverage` and `optical_config_segments`.
**Value:** the `ir_hw_switching` experiment becomes a query. CRC and schema violations become
monitored quantities. **No feature list needed to ship this.**

### Stage 3 — Epoch features + series/window readers
*Cloud only.*
- `opticalEpoch` + whatever `featureSetVersion: 'fs1'` turns out to be once
  `PPG_FEATURE_PRIOR_ART.md` lands. Start with unarguable ones (DC level, AC/DC ratio, saturation
  fraction, per-channel SNR in band) that need no physiological claim.
- Ship `optical_series` and `optical_window`.
**Value:** the capture finally has a reader per VK's rule; features are queryable and comparable
across versions.

### Stage 4 — Re-derivation harness
*Cloud only.*
- Re-run `fs1 → fs2` over the whole archive and diff, proving the central claim of §5 works in
  practice rather than in principle.
**Value:** converts "we can re-derive later" from an assertion into a demonstrated capability. Also
the natural home for backfilling the one existing session.

### Stage 5 — On-device promotion *(conditional; may never happen)*
Only if a feature both validates against varying input **and** must be available offline.
**Prerequisite, and it is not small:** reconcile the fork's 36 GRDB migration ordinals with the
oracle's 31 (§6.4) *without* renaming any identifier a shipped device has already applied. Then pay
the GRDB + Room + `ContentToken` + oracle-fixture tax once, for one feature that earned it, copying
the `ppgWaveformSample` shape.

This stage is listed for completeness and should be treated as unlikely. Stages 0–4 deliver the
whole capability without it.

---

## 9. What could go wrong

### 9.1 The biggest risk: the log eats its own data, silently
Rotation deletes a generation permanently, and **today an 8 h night writes 204 MB against a 125.8 MB
two-generation budget** — so a night captured before Stage 1 lands is *already* losing its oldest
~40% unless background drains happen mid-night. There is no error, no log line, and no metric that
reports this: the watermark simply never had the chance to advance. `deep_buffer_coverage` will show
a shortened session, which looks exactly like the strap not banking — the opposite of the truth
(§2.1(c) shows the strap banks near-perfectly inside a run).

This may already be what produced the observed session's single 5.45 h gap. **Stated carefully: not
established.** A 5.45 h gap is larger than the 4.93 h best-case retention, which is suggestive, but
a disconnect or a capture toggle would look identical. The point is that today there is no way to
tell those apart, which is itself the bug.

**Mitigations:** land Stage 1 before turning on nightly capture. Until then, treat any capture longer
than ~4.9 h as lossy by construction. Add a counter for "bytes destroyed by rotation before the
watermark reached them" — the phone can compute it exactly at rotation time (watermark vs the
rotated generation's size), and it is the only honest way to make this failure visible.

### 9.2 Spectral self-deception
The most likely way this project produces a wrong result. The records are fixed-N-samples-per-second
by construction, so autocorrelation and spectral methods can manufacture a peak at the record period
that looks physiological. This already happened once here (PPG→HR, #194, withdrawn). The decode
doc's own honest note flags that its phase-randomised surrogate scored 29.1% within 6 bpm and
places no weight on it.
**Mitigations:** the load-bearing negative control is **block 3** — a real sampling channel with both
emitter drives at zero, showing prominence x7.8 versus block 0's x114.6 [M]. Every feature must be
reported against block 3 in the same epoch. Any feature that does not separate from block 3 is not a
feature. Persist block 3 always; never "optimise" it away as an empty channel.

### 9.3 The decode is not final
Nine items in §(b) are unpinned, including every wavelength question. A prior wavelength claim was
retracted. `decoderVersion` on every derived row is the hedge, and tier 1 being regenerable is the
insurance. **Do not name any table, column, or MCP field after a physiological interpretation that
the data has not established** — `emitterADrive`, not `ledCurrentMilliamps`; `activeBlocks`, not
`spo2Channels`.

### 9.4 No background runner, one thread, one machine
The server has no scheduler and a single Node thread with `min_machines_running = 1` and
`auto_stop_machines = "stop"`. A decode run that blocks that thread starves `/healthz`; there is
direct precedent in the 36 s cold page-churn walk. A machine that autostops mid-decode loses the run.
**Mitigations:** range-bounded idempotent decode units; resume from `opticalDecodeRun` status; never
introduce an in-process timer (§5.3).

### 9.5 Volume exhaustion
10.53 GB total, 9.29 GB free, but ingest transiently needs a second copy of the 782 MB mirror, and
`requireSpaceFor` will start refusing uploads at the `minFreeBytes` floor. There is a same-month
precedent: the 2026-07-26 disk-full → OOM incident. Tier 2 is ~200 MB/year, which is fine — but
**tier 1 must never be written to the volume**, and a decode bug that spills there would reproduce
that incident.
**Mitigation:** make the tier-1 writer refuse to run when the object store is unconfigured, exactly
as `makeObjectStore` already returns `null` rather than falling back to the filesystem.

### 9.6 Unbounded archive with no lifecycle policy
There is **no bucket lifecycle rule and no retention configuration anywhere in the repo** — verified.
That is correct for tier 0 (keep forever, by policy) but it means a runaway decode loop writing tier
1 has no brake. Cost is trivial at these volumes ([E] single-digit dollars/month), but a bug is
unbounded.
**Mitigation:** tier-1 keys are `optical/v1/{decoderVersion}/...` so a whole bad generation is one
prefix delete; add a per-run byte budget in `opticalDecodeRun`.

### 9.7 Re-decode cost grows forever
Re-deriving `fs1 → fs2` over the archive is linear in archive size, which grows without bound by
design. At 15.7 GB/year of sleep-window capture this is comfortable for years [E], but a full
re-derivation is not a thing to do casually at year five.
**Mitigation:** tier 1 exists precisely so most feature iterations re-read decoded waveforms rather
than re-inflating tier 0; range-scoped re-runs (one month, one season) as the default.

### 9.8 Privacy surface
Raw PPG is biometric data, and `optical_window` hands out signed URLs. The existing 1-hour TTL and
the stated rationale ("short enough that a URL pasted into a transcript is not a durable
credential") are right; keep them. Do not lengthen the TTL for convenience. Note also that the
no-auth URL-secret route serves a strict read-only `public` scope — all four new tools are
read-only and will be reachable there, which is intended but should be a conscious decision.

### 9.9 The upstream boundary
Upstream NOOP is explicitly "no server, no account, no cloud sync" — a hard scope limit in its
CLAUDE.md. Everything in this design except Stage 1's log-format change is fork-only and must stay
behind `#if CLOUD_SYNC`. Stage 1 touches an upstream-safe file, so it needs care: the framed
container is a capture-side improvement (bounded disk for an experimental instrument) that is
defensible upstream on its own merits, but it must not acquire any knowledge of upload.

### 9.10 Schema-parity oracle — a blocker that is currently latent
Not exercised at all by stages 0–4, which is the point. But it is worth stating plainly that **the
fork cannot currently add any on-device table without first fixing the migration-ordinal collision**
(§6.4). That is true today, independently of this design — `imuActivity` already shipped through
that gap. If someone reads this document and decides to put optical features on the phone after all,
that reconciliation is the first task, not the last, and it carries real risk of wedging the
migrator on devices that have already applied the fork-local migrations.

---

## 10. Open questions for VK

1. **Sleep-window or 24/7 to start?** This document recommends sleep-window on signal-quality
   grounds, and shows 24/7 is affordable after Stage 1. Either is defensible; it is a one-constant
   change.
2. **256 MB phone log budget acceptable?** It buys ~6 nights of offline survival. Lower is fine
   after Stage 1; 120 MB still gives ~2.8 nights.
3. **Should Stage 1 go upstream?** The framed compressed log is genuinely better for anyone running
   the #423 capture instrument, not just for the cloud fork.
4. `PPG_FEATURE_PRIOR_ART.md` did not exist when this was written. Stage 3 is deliberately blocked on
   it, and the schema is version-keyed so it does not need to be guessed at.
5. **Separately from this design:** the fork's migration ordinals and the parity oracle have already
   diverged, and `imuActivity` shipped through the gap with no Room twin. That is worth fixing on
   its own schedule, whether or not any optical data ever lands on device.

---

## Appendix — sources for every measured number

- **On-disk rates, gap structure, compression sweeps, decoded sizes:** computed in-session from
  `/Users/vk/VKDEV/NOOP/optical-decode-2140/buffers2140.jsonl` (29,203 records, 128,726,973 B) and
  `buffers1244.jsonl` (29,204 records, 78,172,561 B).
- **Production compression, session extent, per-stream buffer counts:** live `vk-noop-cloud` via
  `deep_buffer_coverage`; volume and mirror sizes via `data_freshness`; table row counts and reader
  mapping via `streams`; the `imuActivity` shortfall via `imu_coverage`.
- **Decode layout, validation results, negative controls, unpinned items, neutral naming:**
  `/Users/vk/VKDEV/NOOP/optical-decode-2140/R20_OFFSETS_2026-07-27.md`.
- **Phone capture/upload behaviour:** `Strand/BLE/PuffinDeepBufferLog.swift`,
  `Strand/CloudSync/DeepBufferUploadPlan.swift`, `DeepBufferUploader.swift`, `CloudSyncModel.swift`,
  `Strand/Collect/PrunePolicy.swift`, `Packages/WhoopStore/.../Database.swift` — read from
  `/Users/vk/VKDEV/NOOP/noop-phone-build` (branch `phone-build`); the `@82`, oracle, and
  `imuActivity` work read from refs `main`, `test/schema-parity-oracle`, and
  `imu-activity-pipeline` respectively.
- **Server architecture:** `/Users/vk/VKDEV/NOOP/noop-cloud/src/{mirror,serverdb,ingest,objectstore,deepbuf,config}.ts`
  and `src/tools/*.ts`, plus `fly.toml`.
