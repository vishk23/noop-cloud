//! Reclaiming crash corpses.
//!
//! The 2026-07-26 outage was not caused by data growth. It was caused by `.staged-<random hex>`
//! files: every failed ingest minted a NEW name, left the partial behind, and consumed exactly the
//! space the next attempt needed. 2.4 GB of them took the volume to zero.
//!
//! liters is mostly immune by construction, and it is worth being precise about *where*:
//!
//! - `replica.rs` temp files (`{db}.apply.tmp`, `{db}.tmp`, `{db}.compact.tmp`, `{db}-txid.tmp`)
//!   are FIXED siblings. `File::create` truncates, so a corpse is overwritten by the next attempt
//!   rather than joined by one. Bounded at one file each, forever. Nothing to sweep.
//! - HTTP PUT spools are created and immediately `unlink`ed (`http/mod.rs::unlinked_temp_file`), so
//!   the kernel reclaims them on any exit. Only a kill landing in the microseconds between
//!   `create_new` and `remove_file` can leave one.
//! - **The bucket is the exception.** `DirReplicaClient::write_ltx_file` names its temp
//!   `{min}-{max}.ltx.{pid}-{seq}.tmp` — deliberately unique per write, so a retry racing a stalled
//!   first attempt cannot unlink the winner's in-flight file. That is the right call for
//!   correctness and it is exactly the accumulating shape that filled the volume: pid varies across
//!   restarts, seq increments within one, and nothing in liters ever collects them. Listings skip
//!   non-`.ltx` names, so they are invisible to the protocol while still occupying the disk.
//!
//! Hence this module, and hence its age guard: a temp file whose mtime is seconds old belongs to a
//! push happening right now, and unlinking it would corrupt a legitimate transfer.

use std::path::Path;
use std::time::{Duration, SystemTime};

#[derive(Debug, Default, Clone, Copy)]
pub struct Swept {
    pub removed: u64,
    pub bytes: u64,
}

fn is_bucket_tmp(name: &str) -> bool {
    // `{min:016x}-{max:016x}.ltx.{pid}-{seq}.tmp`
    name.ends_with(".tmp") && name.contains(".ltx.")
}

fn is_spool(name: &str) -> bool {
    name.starts_with("liters-http-") && name.ends_with(".spool")
}

fn sweep_dir(dir: &Path, older_than: Duration, matches: fn(&str) -> bool, out: &mut Swept) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = match name.to_str() {
            Some(n) => n,
            None => continue,
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            // Levels are directories; recurse one layer so `ltx/0/…tmp` is reachable.
            sweep_dir(&entry.path(), older_than, matches, out);
            continue;
        }
        if !matches(name) {
            continue;
        }
        let age = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok());
        match age {
            Some(a) if a >= older_than => {}
            _ => continue, // too young, or an unreadable mtime — leave it alone
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            out.removed += 1;
            out.bytes += meta.len();
        }
    }
}

/// Sweeps the bucket's stray LTX temp files and any orphaned HTTP spool.
///
/// Best-effort by construction: every error is swallowed. A sweep that cannot delete must never
/// fail the apply it runs inside — that is how a cleanup path becomes an outage.
pub fn sweep(bucket_dir: &Path, tmp_dir: &Path, older_than: Duration) -> Swept {
    let mut out = Swept::default();
    sweep_dir(bucket_dir, older_than, is_bucket_tmp, &mut out);
    sweep_dir(tmp_dir, older_than, is_spool, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_shapes_liters_actually_writes() {
        assert!(is_bucket_tmp(
            "0000000000000001-000000000000000c.ltx.4242-0.tmp"
        ));
        assert!(is_bucket_tmp(
            "0000000000000001-0000000000000001.ltx.1-ff.tmp"
        ));
        // A real LTX file must never match, or a sweep would delete replication history.
        assert!(!is_bucket_tmp("0000000000000001-000000000000000c.ltx"));
        assert!(!is_bucket_tmp("mirror.sqlite"));
        assert!(is_spool("liters-http-4242-1a.spool"));
        assert!(!is_spool("mirror.sqlite.apply.tmp"));
    }

    #[test]
    fn young_files_survive_and_old_ones_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let level = dir.path().join("ltx").join("0");
        std::fs::create_dir_all(&level).unwrap();
        let young = level.join("0000000000000001-0000000000000001.ltx.1-0.tmp");
        let real = level.join("0000000000000001-0000000000000001.ltx");
        std::fs::write(&young, b"in flight").unwrap();
        std::fs::write(&real, b"history").unwrap();

        // Age guard holds: a push happening right now keeps its temp file.
        let s = sweep(dir.path(), dir.path(), Duration::from_secs(3600));
        assert_eq!(s.removed, 0);
        assert!(young.exists());

        // With no guard, the corpse goes and the real file stays.
        let s = sweep(dir.path(), dir.path(), Duration::ZERO);
        assert_eq!(s.removed, 1);
        assert!(!young.exists());
        assert!(real.exists());
    }
}
