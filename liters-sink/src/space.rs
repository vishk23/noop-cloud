//! Disk preflight.
//!
//! The reason this file exists: under `/ingest` an apply happens in a throwaway `.staged-*.sqlite`
//! and is published by `rename(2)`, so ENOSPC mid-write costs a temp file and nothing else — the
//! live mirror is bit-identical to what it was. `Replica::apply_ltx_file` writes pages **into the
//! live mirror**, so the same ENOSPC now lands inside the file every MCP tool reads.
//!
//! That torn state is self-healing (`{db}-txid` is only advanced after a *completed* apply, so the
//! next sync re-applies the same file and rewrites every page it touched), but "self-healing once
//! there is space again" is not a reason to start an apply on a volume that has none. So: refuse
//! before the first page, with arithmetic rather than a guess.
//!
//! The arithmetic is exact because LTX says so. Every LTX file's 100-byte header carries `commit` —
//! the database size in pages *after* the file applies — and `page_size`. So the post-apply file
//! size is known before a byte is written, and the growth term is `max(0, commit*page_size -
//! current_size)`. The spool term is the LTX file's own size, since `apply_ltx_file` copies it to
//! `{db}.apply.tmp` before decoding.

use std::io::BufReader;
use std::path::Path;

use liters::{ReplicaClient, Txid};
use ltx::Decoder;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpaceNeed {
    /// Bytes the `{db}.apply.tmp` spool will hold (the largest single pending LTX file).
    pub spool_bytes: u64,
    /// Bytes the mirror itself will grow by.
    pub growth_bytes: u64,
    /// What the volume reports as available to an ordinary writer.
    pub free_bytes: u64,
    /// Headroom that must survive the apply.
    pub min_free_bytes: u64,
}

impl SpaceNeed {
    pub fn needed(&self) -> u64 {
        self.spool_bytes + self.growth_bytes + self.min_free_bytes
    }
    pub fn fits(&self) -> bool {
        self.free_bytes >= self.needed()
    }
}

/// `bavail`, not `bfree`: the number `df` prints as "Avail". Excluding root-reserved blocks is the
/// correct bias for a guard whose whole job is refusing writes that might not fit. `None` means the
/// platform could not answer — never treat "unknown" as "full".
pub fn free_bytes(dir: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some(st.f_bavail as u64 * st.f_frsize as u64)
}

/// Current on-disk size of the mirror; 0 when it does not exist yet (a first sync is a full
/// restore, which materializes to `{db}.tmp` and renames — so the growth term is the whole file).
fn file_size(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// Reads one LTX file's header without decoding its pages.
fn ltx_commit_bytes(client: &dyn ReplicaClient, level: u8, min: Txid, max: Txid) -> Option<u64> {
    let rd = client.open_ltx_file(level, min, max, 0, 0).ok()?;
    let mut dec = Decoder::new(BufReader::new(rd));
    dec.decode_header().ok()?;
    let h = dec.header();
    Some(h.commit as u64 * h.page_size as u64)
}

/// What the next sync round would need, given the bucket's pending files.
///
/// Deliberately pessimistic in two directions and cheap in a third:
/// - the spool term is the LARGEST pending file, not the sum, because `apply_ltx_file` spools one
///   file at a time and `TmpGuard` unlinks each before the next;
/// - the growth term is the LARGEST post-apply size across pending files, not the last one, because
///   an intermediate transaction can be bigger than the final one (a big insert then a delete);
/// - only level 0 and the snapshot level are inspected. Levels 1-8 only ever summarise history
///   already covered, so a pending L0 chain bounds them.
pub fn plan(
    client: &dyn ReplicaClient,
    mirror_path: &Path,
    position: Txid,
    min_free_bytes: u64,
) -> Option<SpaceNeed> {
    let free = free_bytes(mirror_path.parent().unwrap_or(Path::new(".")))?;
    let current = file_size(mirror_path);

    let mut spool = 0u64;
    let mut biggest_after = 0u64;
    for level in [0u8, liters::SNAPSHOT_LEVEL] {
        let files = match client.ltx_files(level, Txid(0), false) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for f in files {
            if f.max_txid <= position {
                continue; // already applied
            }
            spool = spool.max(f.size);
            if let Some(after) = ltx_commit_bytes(client, level, f.min_txid, f.max_txid) {
                biggest_after = biggest_after.max(after);
            }
        }
    }

    Some(SpaceNeed {
        spool_bytes: spool,
        growth_bytes: biggest_after.saturating_sub(current),
        free_bytes: free,
        min_free_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needed_is_spool_plus_growth_plus_headroom_and_fits_is_exact() {
        let n = SpaceNeed {
            spool_bytes: 10,
            growth_bytes: 20,
            free_bytes: 60,
            min_free_bytes: 30,
        };
        assert_eq!(n.needed(), 60);
        // Exactly enough is enough: the guard refuses only what genuinely does not fit.
        assert!(n.fits());
        assert!(!SpaceNeed {
            free_bytes: 59,
            ..n
        }
        .fits());
    }

    #[test]
    fn free_bytes_answers_for_a_real_directory_and_none_for_a_missing_one() {
        let dir = tempfile::tempdir().unwrap();
        assert!(free_bytes(dir.path()).unwrap() > 0);
        assert!(free_bytes(Path::new("/definitely/not/a/path/here")).is_none());
    }
}
