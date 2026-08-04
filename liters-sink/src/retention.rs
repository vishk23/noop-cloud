//! Bounding the committed LTX bucket.
//!
//! The 2026-08-03 outage — the third full volume on this machine, and the first one that was real
//! data rather than crash corpses. `/data/ltx-bucket` reached 7.8 GB across 27 committed `.ltx`
//! files and took a 10 GB volume to zero bytes free.
//!
//! What made it 7.8 GB is worth stating exactly, because the shape is what the fix has to survive:
//! every file was `{n}-{n}.ltx` — min == max, ONE transaction each — and every file was 320-395 MB,
//! a near-complete copy of the 967 MB mirror. The phone replaces its whole database on each rebuild,
//! so every page is dirty and every "delta" is the database. Growth ran at ~800 MB/day and nothing
//! in the system had an opinion about it.
//!
//! Nothing did, because nothing was supposed to. Retention in liters is the **device's** job
//! (`compaction.rs`: "the device is the sole writer of its bucket prefix, so it is also the sole
//! compactor"), and a device that never calls `Writer::maintain` leaves a bucket that only grows.
//! [`crate::sweep`] is not that mechanism and must not be made into one: it reclaims
//! `.ltx.<pid>-<seq>.tmp` corpses and orphaned spools, and its tests assert that a real `.ltx` file
//! never matches. During the outage it correctly reported `sweptTotal: 0` — there were zero corpses.
//! The two counters are kept separate in the status file (`sweptTotal` vs `prunedTotal`) so that
//! answer is never again mistaken for "cleanup ran and found nothing".
//!
//! The consequence of unbounded growth was not a slow degradation, it was a deadlock: the applier
//! refused with `refusing apply: needs 665131152 (spool 394889360 + growth 1806336 + 268435456
//! headroom), 0 free` and accrued 79,024 identical errors without ever reclaiming the thing that was
//! full. `/ingest` — the fallback path — died on the same volume, so the phone's uploads were
//! rejected and the app's spinner hung forever. Manual recovery was to delete all but the newest 3
//! `.ltx`, which freed 6.7 GB; the sink then walked back to `ok: true` on its own in ~10 minutes.
//! This module is that recovery, made automatic and made safe.
//!
//! # What must never be deleted
//!
//! Three invariants, checked before any policy is consulted. Each one is a specific failure:
//!
//! 1. **A segment at or above the mirror's applied `position`.** Above it is unapplied data — the
//!    thing replication exists to deliver. At it is the file that produced the current position.
//! 2. **The level's max-TXID file.** This is the load-bearing one and it is not obvious. Bucket max
//!    is the sink's own divergence evidence (`Replica::finish_incremental`: `bucket_max < current`
//!    is `Error::Diverged`, and `auto_reset` is deliberately false here, so that is a hard stop) and
//!    it is simultaneously the phone's lineage baseline (`Writer::ensure_lineage_checked` compares
//!    the bucket's max L0 TXID against its own verified position; a bucket that moved reads as a
//!    foreign writer and forces a rebaseline — a fresh full-database snapshot push). Deleting the
//!    head of a level to reclaim one more file would trade 395 MB for a 967 MB re-upload and a
//!    stopped replica. It also reproduces liters' own stated invariants for stock readers: every
//!    level keeps at least one file, and the newest snapshot is never deleted.
//! 3. **A segment younger than the grace window.** Same reasoning as [`crate::sweep`]'s age guard,
//!    weaker here: a committed `.ltx` is complete by `rename(2)`, and a reader mid-restore is
//!    covered by unlink-while-open (POSIX directly, and over HTTP by the server holding the backend
//!    reader open for the whole transfer). The guard is cheap insurance against clock and ordering
//!    surprises, not the thing making this safe — invariants 1 and 2 are.
//!
//! Deletion is **prefix-only**: files are walked oldest-first and the walk stops at the first
//! retained file, so the surviving chain is always contiguous. A hole in the middle would be
//! invisible until some future restore planned across it. This is exactly the discipline
//! `enforce_l0_retention` uses upstream, for exactly that reason.
//!
//! Note that `position == 0` protects the entire bucket, which falls out of invariant 1 rather than
//! being a special case, and is correct: nothing has been applied, so the whole chain may be needed
//! for the full restore that has not happened yet.
//!
//! # Why this prunes rather than compacts
//!
//! Compaction is the better answer in general — collapsing L0 `[a..b]` into one L1 file keeps the
//! history addressable instead of dropping it — and liters can already do it. It is not driven from
//! here, for four reasons, in descending order of how much they matter:
//!
//! - **It would make the server a second compactor.** `Writer::compact_level` is a `Writer` method
//!   and a `Writer` needs a local database and WAL; the sink has a [`liters::Replica`], so driving
//!   it would mean reimplementing the merge over `ltx::Compactor` (which is public, and this crate
//!   already depends on `ltx`) and PUTting L1 files into a bucket whose designated sole compactor is
//!   the phone. Two compactors racing `seek = max L1 + 1` is legal — plan.rs tolerates overlap — but
//!   it is precisely the coordination liters' design avoids by construction, and it would arrive
//!   with the phone's `enforce_l0_retention` then deleting L0 files against coverage the server
//!   wrote.
//! - **It costs the resource it is trying to reclaim.** Merging N sources reads all N and writes a
//!   full-size spool plus a full-size L1 file. In the state this module exists to fix — zero bytes
//!   free — a compaction pass cannot start, and a reclaim path that needs free space to free space
//!   is not a reclaim path.
//! - **On this workload it saves no more than pruning.** Every segment is already a near-complete
//!   page image, so merging 24 of them yields one file the size of the database. Keeping the newest
//!   3 lands in the same place for a directory listing and a few `unlink`s.
//! - **Server-side pruning is a first-class protocol state, not a workaround.** `StreamEvent::Gap`
//!   and the `gap {next_min}` frame exist to tell a follower its position was pruned at level 0, and
//!   the restore path treats a mid-plan 404 as re-plan rather than failure. Followers already know
//!   how to survive this.
//!
//! The real fix for the underlying shape is the phone calling `Writer::maintain`, which snapshots
//! and compacts at the only place that has the database. This module is the receiver's guarantee
//! that a device which never does so cannot take the volume down.

use std::time::{Duration, SystemTime};

use liters::{ReplicaClient, Txid, SNAPSHOT_LEVEL};
use ltx::FileInfo;

/// What retention is allowed to keep. Every field is a *ceiling on retention*, never a licence to
/// delete: the invariants in the module docs are checked first and win.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// Master switch. Off leaves the bucket to whatever else manages it — an object-store lifecycle
    /// rule, an operator, the device. Mirrors `MaintenanceOptions::retention_enabled`.
    pub enabled: bool,
    /// Committed segments to retain per level, counted from the newest. The level's head counts
    /// toward it, so `keep: 3` against a fully applied level leaves exactly three files — "delete
    /// all but the newest 3", which is what manual recovery did on 2026-08-03. `0` retains nothing
    /// beyond the invariants, which still leaves the head.
    pub keep: u64,
    /// Bucket-wide byte ceiling. When exceeded, retention keeps deleting past `keep` — oldest first,
    /// still invariant-bound — until the bucket is under it. `0` disables.
    pub max_bytes: u64,
    /// Applied segments older than this are dropped even when `keep` would have retained them.
    /// `0` disables.
    pub max_age: Duration,
    /// A segment younger than this is never touched.
    pub grace: Duration,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            enabled: true,
            // Three is what manual recovery used on 2026-08-03 and what it takes to reclaim 6.7 GB
            // of the 7.8 GB. It is history for a follower or a human, not a safety margin — the
            // invariants are the safety margin — so it is cheap to set low and pointless to set
            // high on a workload whose every segment is a full page image.
            keep: 3,
            max_bytes: 0,
            max_age: Duration::ZERO,
            grace: Duration::from_secs(60),
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Pruned {
    pub removed: u64,
    pub bytes: u64,
}

/// Whether `f` is old enough to touch. An unknown or future-dated timestamp reads as "too young":
/// `created_at` on a directory backing is the LTX header timestamp (the device's clock at commit,
/// preserved as mtime), so it is not this machine's clock and the conservative direction is the only
/// defensible one.
fn past_grace(f: &FileInfo, now: SystemTime, grace: Duration) -> bool {
    match f.created_at {
        Some(at) => now.duration_since(at).map(|age| age >= grace).unwrap_or(false),
        None => false,
    }
}

fn older_than(f: &FileInfo, now: SystemTime, age: Duration) -> bool {
    match f.created_at {
        Some(at) => now.duration_since(at).map(|a| a >= age).unwrap_or(false),
        None => false,
    }
}

/// Decides what to delete, without touching anything.
///
/// `levels` is `(level, listing)` pairs, each listing ascending by `(min_txid, max_txid)` as every
/// [`ReplicaClient::ltx_files`] implementation returns them. The level is passed explicitly and
/// stamped onto the returned infos so a caller cannot address a delete at the wrong level.
///
/// Returns victims in deletion order: level-ascending, then oldest-first. Level 0 leads because it
/// is the replication log and therefore where the bytes are; the snapshot level trails because a
/// snapshot is the one file that can rebuild the database from nothing.
pub fn plan(
    levels: &[(u8, Vec<FileInfo>)],
    position: Txid,
    policy: &Policy,
    now: SystemTime,
) -> Vec<FileInfo> {
    let mut victims = Vec::new();
    if !policy.enabled {
        return victims;
    }

    let mut total: u64 = levels
        .iter()
        .flat_map(|(_, files)| files.iter())
        .map(|f| f.size)
        .sum();

    for (level, files) in levels {
        let Some(head) = files.iter().map(|f| f.max_txid).max() else {
            continue;
        };
        // The last `keep` entries of an ascending listing are the newest ones.
        let keep = usize::try_from(policy.keep).unwrap_or(usize::MAX);
        let retained_from = files.len().saturating_sub(keep);

        for (i, f) in files.iter().enumerate() {
            // --- invariants: any of these ends the level, because the listing is ascending and
            // deletion must stay a prefix ---
            if f.max_txid >= position {
                break; // unapplied, or the file that produced the current position
            }
            if f.max_txid == head {
                break; // the level's head: bucket max, lineage baseline, divergence evidence
            }
            if !past_grace(f, now, policy.grace) {
                break;
            }

            // --- policy: retained by `keep` unless a ceiling says otherwise ---
            let over_bytes = policy.max_bytes > 0 && total > policy.max_bytes;
            let expired = !policy.max_age.is_zero() && older_than(f, now, policy.max_age);
            if i >= retained_from && !over_bytes && !expired {
                break;
            }

            total -= f.size;
            victims.push(FileInfo {
                level: *level,
                ..f.clone()
            });
        }
    }
    victims
}

/// Applies [`plan`] against the bucket.
///
/// Best-effort by construction, like [`crate::sweep`]: every error is swallowed and a failed delete
/// simply is not counted. This runs inside the apply round, and a reclaim path that can fail the
/// replication it protects is how a cleanup becomes an outage — which is the whole subject of this
/// file.
pub fn prune(client: &dyn ReplicaClient, position: Txid, policy: &Policy) -> Pruned {
    let mut out = Pruned::default();
    if !policy.enabled {
        return out;
    }

    let mut levels = Vec::with_capacity(SNAPSHOT_LEVEL as usize + 1);
    for level in 0..=SNAPSHOT_LEVEL {
        levels.push((
            level,
            client.ltx_files(level, Txid(0), false).unwrap_or_default(),
        ));
    }

    // One call per file rather than one batched call: a mid-list failure then still leaves the
    // preceding deletes counted, and the counters in the status file stay honest about what was
    // actually reclaimed.
    for f in plan(&levels, position, policy, SystemTime::now()) {
        if client.delete_ltx_files(std::slice::from_ref(&f)).is_ok() {
            out.removed += 1;
            out.bytes += f.size;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An L0 segment as the phone writes them: one TXID, `min == max`.
    fn seg(txid: u64, size: u64, age_secs: u64) -> FileInfo {
        FileInfo {
            level: 0,
            min_txid: Txid(txid),
            max_txid: Txid(txid),
            size,
            created_at: Some(now() - Duration::from_secs(age_secs)),
            ..Default::default()
        }
    }

    /// A multi-TXID range, as a compaction or a snapshot produces.
    fn range(level: u8, min: u64, max: u64, size: u64, age_secs: u64) -> FileInfo {
        FileInfo {
            level,
            min_txid: Txid(min),
            max_txid: Txid(max),
            size,
            created_at: Some(now() - Duration::from_secs(age_secs)),
            ..Default::default()
        }
    }

    /// Fixed enough to be deterministic, real enough that `duration_since` behaves.
    fn now() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000)
    }

    fn txids(v: &[FileInfo]) -> Vec<u64> {
        v.iter().map(|f| f.max_txid.0).collect()
    }

    /// The outage, replayed: 27 one-TXID segments, all applied, retention set to the 3 that manual
    /// recovery kept. 24 go, and the 24 that go are the oldest 24.
    #[test]
    fn keeps_the_newest_n_and_drops_the_rest_oldest_first() {
        let files: Vec<FileInfo> = (1..=27).map(|n| seg(n, 350_000_000, 86_400)).collect();
        let p = Policy::default();
        let victims = plan(&[(0, files)], Txid(27), &p, now());

        assert_eq!(victims.len(), 24);
        assert_eq!(txids(&victims), (1..=24).collect::<Vec<_>>());
        // 24 x 350 MB — the 6.7 GB that manual recovery reclaimed.
        assert_eq!(
            victims.iter().map(|f| f.size).sum::<u64>(),
            24 * 350_000_000
        );
    }

    /// Invariant 1. Everything the mirror has not applied is untouchable, and so is the file that
    /// produced the position it is at — deleting either is deleting replication.
    #[test]
    fn never_deletes_at_or_above_the_applied_position() {
        // Applied through 5; 6..10 are pending. keep=0 so only the invariants can protect anything.
        let files: Vec<FileInfo> = (1..=10).map(|n| seg(n, 100, 86_400)).collect();
        let p = Policy {
            keep: 0,
            ..Policy::default()
        };
        let victims = plan(&[(0, files)], Txid(5), &p, now());
        assert_eq!(txids(&victims), vec![1, 2, 3, 4]);
    }

    /// Invariant 2, the one that is not obvious. With every segment applied and `keep: 0`, the
    /// tempting answer is "delete all ten". Doing so drops bucket max below the mirror's position,
    /// which `Replica::finish_incremental` reports as `Error::Diverged` (and `auto_reset` is off, so
    /// replication stops), while the phone's `ensure_lineage_checked` reads the same bucket as a
    /// foreign writer and re-snapshots the entire database. The head stays.
    #[test]
    fn never_deletes_the_level_head_even_when_everything_is_applied() {
        let files: Vec<FileInfo> = (1..=10).map(|n| seg(n, 100, 86_400)).collect();
        let p = Policy {
            keep: 0,
            ..Policy::default()
        };
        let victims = plan(&[(0, files)], Txid(10), &p, now());
        assert_eq!(txids(&victims), (1..=9).collect::<Vec<_>>());
        assert!(!txids(&victims).contains(&10));
    }

    /// Invariant 1 with nothing applied yet. Not a special case in the code, and load-bearing: at
    /// position 0 the whole chain is what a full restore would plan across.
    #[test]
    fn position_zero_protects_the_whole_bucket() {
        let files: Vec<FileInfo> = (1..=27).map(|n| seg(n, 350_000_000, 86_400)).collect();
        let p = Policy {
            keep: 0,
            max_bytes: 1,
            ..Policy::default()
        };
        assert!(plan(&[(0, files)], Txid(0), &p, now()).is_empty());
    }

    /// Deletion is a prefix. A young segment in the middle stops the walk rather than being skipped
    /// over — a hole in the chain is invisible until some later restore plans across it.
    #[test]
    fn stops_at_the_first_retained_file_so_the_chain_never_gains_a_hole() {
        let mut files: Vec<FileInfo> = (1..=10).map(|n| seg(n, 100, 86_400)).collect();
        files[2] = seg(3, 100, 0); // pushed seconds ago
        let p = Policy {
            keep: 0,
            ..Policy::default()
        };
        let victims = plan(&[(0, files)], Txid(10), &p, now());
        assert_eq!(txids(&victims), vec![1, 2]);
    }

    /// The grace window, in both directions. A future-dated header timestamp — the device's clock,
    /// not this machine's — reads as "too young" rather than "infinitely old".
    #[test]
    fn young_and_future_dated_segments_survive_the_grace_guard() {
        let p = Policy {
            keep: 0,
            grace: Duration::from_secs(60),
            ..Policy::default()
        };

        let young: Vec<FileInfo> = (1..=5).map(|n| seg(n, 100, 10)).collect();
        assert!(plan(&[(0, young)], Txid(5), &p, now()).is_empty());

        let mut skewed: Vec<FileInfo> = (1..=5).map(|n| seg(n, 100, 86_400)).collect();
        skewed[0].created_at = Some(now() + Duration::from_secs(86_400));
        assert!(plan(&[(0, skewed)], Txid(5), &p, now()).is_empty());

        let old: Vec<FileInfo> = (1..=5).map(|n| seg(n, 100, 3_600)).collect();
        assert_eq!(plan(&[(0, old)], Txid(5), &p, now()).len(), 4);
    }

    /// The byte ceiling deletes past `keep`, and stops the moment the bucket is under it.
    #[test]
    fn the_byte_ceiling_lowers_keep_but_stops_when_satisfied() {
        let files: Vec<FileInfo> = (1..=10).map(|n| seg(n, 100, 86_400)).collect();
        let p = Policy {
            keep: 8, // would retain 8 of 10 on its own
            max_bytes: 500,
            ..Policy::default()
        };
        // 1000 bytes held, ceiling 500: delete oldest-first until 500 remain.
        let victims = plan(&[(0, files)], Txid(10), &p, now());
        assert_eq!(txids(&victims), vec![1, 2, 3, 4, 5]);
    }

    /// A ceiling smaller than the invariants allow is a ceiling that is not met. Retention reports
    /// what it did; it does not escalate into deleting the head or unapplied data.
    #[test]
    fn the_byte_ceiling_never_breaches_the_invariants() {
        let files: Vec<FileInfo> = (1..=10).map(|n| seg(n, 100, 86_400)).collect();
        let p = Policy {
            keep: 0,
            max_bytes: 1,
            ..Policy::default()
        };
        // Applied through 7, so 8/9 are pending and 10 is the head: six deletable, 400 bytes left.
        let victims = plan(&[(0, files)], Txid(7), &p, now());
        assert_eq!(txids(&victims), vec![1, 2, 3, 4, 5, 6]);
    }

    /// The age ceiling drops applied segments `keep` would have retained.
    #[test]
    fn the_age_ceiling_expires_segments_keep_would_have_held() {
        let mut files: Vec<FileInfo> = (1..=6).map(|n| seg(n, 100, 60)).collect();
        for f in files.iter_mut().take(3) {
            f.created_at = Some(now() - Duration::from_secs(30 * 86_400));
        }
        let p = Policy {
            keep: 5,
            max_age: Duration::from_secs(7 * 86_400),
            ..Policy::default()
        };
        let victims = plan(&[(0, files)], Txid(6), &p, now());
        assert_eq!(txids(&victims), vec![1, 2, 3]);
    }

    /// Levels are independent, each keeps its own head, and the snapshot level is planned last —
    /// a snapshot is the only file that can rebuild the database from nothing.
    #[test]
    fn every_level_keeps_a_head_and_snapshots_are_planned_last() {
        let l0: Vec<FileInfo> = (10..=14).map(|n| seg(n, 100, 86_400)).collect();
        let l1 = vec![
            range(1, 1, 4, 500, 86_400),
            range(1, 5, 9, 500, 86_400),
            range(1, 10, 12, 500, 86_400),
        ];
        let l9 = vec![range(9, 1, 4, 900, 86_400), range(9, 1, 9, 900, 86_400)];
        let p = Policy {
            keep: 0,
            ..Policy::default()
        };
        let victims = plan(&[(0, l0), (1, l1), (9, l9)], Txid(14), &p, now());

        let by_level: Vec<(u8, u64)> = victims.iter().map(|f| (f.level, f.max_txid.0)).collect();
        assert_eq!(
            by_level,
            vec![(0, 10), (0, 11), (0, 12), (0, 13), (1, 4), (1, 9), (9, 4)]
        );
        // Each level's head survived: L0 14, L1 10-12, L9 1-9.
        assert!(!by_level.contains(&(0, 14)));
        assert!(!by_level.contains(&(1, 12)));
        assert!(!by_level.contains(&(9, 9)));
    }

    /// The kill switch. `LITERS_LTX_RETENTION=0` hands the bucket back to whatever else manages it.
    #[test]
    fn disabled_deletes_nothing() {
        let files: Vec<FileInfo> = (1..=27).map(|n| seg(n, 350_000_000, 86_400)).collect();
        let p = Policy {
            enabled: false,
            keep: 0,
            ..Policy::default()
        };
        assert!(plan(&[(0, files.clone())], Txid(27), &p, now()).is_empty());

        let dir = tempfile::tempdir().unwrap();
        let client = liters::DirReplicaClient::new(dir.path());
        assert_eq!(prune(&client, Txid(27), &p), Pruned::default());
    }

    /// End to end against the real directory backing: the files named for deletion are the files
    /// that leave the volume, and the reclaimed byte count is the one the status file will report.
    #[test]
    fn prunes_a_real_bucket_and_counts_what_it_reclaimed() {
        let dir = tempfile::tempdir().unwrap();
        let level0 = dir.path().join("ltx").join("0");
        std::fs::create_dir_all(&level0).unwrap();

        let old = SystemTime::now() - Duration::from_secs(86_400);
        for n in 1u64..=10 {
            let p = level0.join(ltx::format_filename(Txid(n), Txid(n)));
            std::fs::write(&p, vec![b'p'; 1_000]).unwrap();
            let f = std::fs::File::options().write(true).open(&p).unwrap();
            f.set_times(
                std::fs::FileTimes::new()
                    .set_accessed(old)
                    .set_modified(old),
            )
            .unwrap();
        }
        // A crash corpse from sweep.rs's world, sitting in the same directory. Retention must not
        // see it (listings skip non-`.ltx` names) and must not need to.
        let corpse = level0.join("0000000000000001-0000000000000001.ltx.4242-0.tmp");
        std::fs::write(&corpse, b"corpse").unwrap();

        let client = liters::DirReplicaClient::new(dir.path());
        let pruned = prune(&client, Txid(10), &Policy::default());

        assert_eq!(pruned.removed, 7);
        assert_eq!(pruned.bytes, 7_000);
        for n in 1u64..=7 {
            assert!(!level0
                .join(ltx::format_filename(Txid(n), Txid(n)))
                .exists());
        }
        for n in 8u64..=10 {
            assert!(level0.join(ltx::format_filename(Txid(n), Txid(n))).exists());
        }
        assert!(corpse.exists(), "retention must leave sweep's work alone");

        // Idempotent: a second pass has nothing left that policy allows it to take.
        assert_eq!(prune(&client, Txid(10), &Policy::default()), Pruned::default());
    }

    /// The 2026-08-03 confusion, encoded. `sweptTotal` counts crash corpses and `prunedTotal` counts
    /// committed history; no file can ever be claimed by both, which is what made `sweptTotal: 0`
    /// read as "cleanup found nothing wrong" while 7.8 GB of real segments sat on the volume.
    #[test]
    fn retention_and_the_sweep_never_claim_the_same_file() {
        let names = [
            "0000000000000001-0000000000000001.ltx",
            "0000000000000001-000000000000000c.ltx",
            "0000000000000001-0000000000000001.ltx.4242-0.tmp",
            "liters-http-4242-1a.spool",
        ];
        for name in names {
            let listed = ltx::parse_filename(name).is_some();
            let corpse = crate::sweep::is_reclaimable_corpse(name);
            assert!(
                !(listed && corpse),
                "{name} is claimed by both retention and the sweep"
            );
        }
        // And the split is not vacuous in either direction.
        assert!(ltx::parse_filename("0000000000000001-000000000000000c.ltx").is_some());
        assert!(crate::sweep::is_reclaimable_corpse(
            "0000000000000001-0000000000000001.ltx.4242-0.tmp"
        ));
    }
}
