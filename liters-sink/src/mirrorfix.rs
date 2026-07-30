//! Forcing the mirror to present as a **rollback-journal** database.
//!
//! This module exists because of a measured defect, not a theory.
//!
//! liters materializes a bucket two different ways. `Replica::apply_spooled` (the incremental path)
//! stamps SQLite header bytes 18/19 to `0x01` and randomizes the change counter at 24..28 — that is
//! how it presents a rollback-journal file and invalidates other connections' page caches.
//! `Replica::full_restore` (the bootstrap path) does not: it pipes the merged LTX straight through
//! `decode_database_to`, so the image keeps whatever the **source** database's header said. The
//! phone's `noop.sqlite` is a GRDB WAL database, so a fresh restore lands a mirror whose header
//! claims **WAL mode with no `-wal` and no `-shm`**.
//!
//! Measured consequence, on this repo's own reader configuration
//! (`new Database(path, { readonly: true, fileMustExist: true })`, src/mirror.ts:57):
//!
//! ```text
//!   header[18],[19] = 2 2
//!   sidecars: [ 'm.sqlite' ]
//!   readonly open: OK; rows = 1
//!   after readonly attempt, sidecars: [ 'm.sqlite', 'm.sqlite-shm', 'm.sqlite-wal' ]
//! ```
//!
//! The read *succeeds* — which is why this would not have been caught by a smoke test — and in
//! succeeding it **creates `-wal` and `-shm` on the data volume**. `SQLITE_OPEN_READONLY` restricts
//! writes to the database, not to the sidecars, and SQLite happily builds a WAL index for a
//! read-only connection when the directory is writable.
//!
//! Two things break as a result, and the second is the serious one:
//!
//! 1. Every MCP read starts creating files on a volume that has already been to zero bytes free.
//! 2. **The mutual exclusion between applier and reader silently stops working.** liters takes
//!    SQLite's *rollback-journal* lock pair (PENDING byte + the SHARED range) and relies on the
//!    change counter for cache invalidation. A WAL-mode connection takes neither of those locks and
//!    does not consult the change counter — it reads through the `-shm` index. So an applier
//!    writing pages in place and a reader in WAL mode are not serialized against each other at all,
//!    and the reader's WAL index describes a file that is being rewritten underneath it.
//!
//! So the invariant this module enforces — *the mirror always presents as a rollback-journal file*
//! — is not cosmetic tidiness. It is the precondition for every safety property in
//! docs/LITERS_RECEIVE.md.
//!
//! The residual window is named honestly: `full_restore` publishes by `rename(2)` and this fixup
//! runs when `sync()` returns, so there is a gap of milliseconds in which the mirror exists with a
//! WAL header. It is bounded (the sink runs `IntegrityCheck::None` precisely so the restore does
//! not sit in a 766 MB `quick_check` inside that gap — the sink runs its own check afterwards), it
//! only happens on bootstrap and re-baseline, and any sidecars a reader manages to create in it are
//! removed by the same pass.

use std::fs::OpenOptions;
use std::io;
use std::os::unix::fs::FileExt;
use std::path::Path;

/// Offsets in the SQLite database header (https://sqlite.org/fileformat.html#the_database_header).
const WRITE_VERSION: u64 = 18;
const LEGACY: u8 = 1; // 1 = rollback journal, 2 = WAL
const CHANGE_COUNTER: usize = 24;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Fixup {
    /// The header claimed WAL and was rewritten.
    pub stamped: bool,
    /// Stale `-wal`/`-shm` files were removed.
    pub sidecars_removed: u32,
}

impl Fixup {
    pub fn changed(&self) -> bool {
        self.stamped || self.sidecars_removed > 0
    }
}

/// Reads the mirror's write/read version bytes. `None` when the file is absent or too short to be
/// a database yet.
pub fn journal_bytes(path: &Path) -> Option<(u8, u8)> {
    let f = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 2];
    f.read_exact_at(&mut buf, WRITE_VERSION).ok()?;
    Some((buf[0], buf[1]))
}

/// Removes `-wal`/`-shm` beside the mirror. A rollback-journal database has no use for either, and
/// leaving a stale WAL index next to a file being rewritten in place is how a reader ends up
/// consulting an index that no longer describes the data.
fn remove_sidecars(path: &Path) -> u32 {
    let mut n = 0;
    for suffix in ["-wal", "-shm"] {
        let mut p = path.as_os_str().to_owned();
        p.push(suffix);
        if std::fs::remove_file(std::path::PathBuf::from(p)).is_ok() {
            n += 1;
        }
    }
    n
}

/// Makes the mirror present as a rollback-journal database, idempotently.
///
/// The write is a **single 10-byte `pwrite`** covering bytes 18..28 — the two version bytes plus
/// the change counter — so a reader cannot observe the version updated without the counter, which
/// is the only interleaving that would matter (it would let a reader keep a stale page cache while
/// believing the file had not changed).
///
/// Returns what it had to do, so the caller can log a one-off rather than a heartbeat.
pub fn ensure_rollback_journal(path: &Path) -> io::Result<Fixup> {
    let mut out = Fixup::default();
    let current = match journal_bytes(path) {
        Some(v) => v,
        None => return Ok(out), // no mirror yet — nothing to enforce
    };

    if current != (LEGACY, LEGACY) {
        let f = OpenOptions::new().read(true).write(true).open(path)?;
        let mut patch = [0u8; 10];
        patch[0] = LEGACY; // byte 18, write version
        patch[1] = LEGACY; // byte 19, read version
                           // bytes 20..24 (reserved space, max/min payload fractions) must be preserved.
        let mut keep = [0u8; 4];
        f.read_exact_at(&mut keep, 20)?;
        patch[2..6].copy_from_slice(&keep);
        // The change counter, bumped so every other connection's page cache is invalidated. This is
        // the same signal liters' incremental path sends; a monotonic bump is enough and avoids
        // pulling in an RNG.
        let mut counter = [0u8; 4];
        f.read_exact_at(&mut counter, CHANGE_COUNTER as u64)?;
        let next = u32::from_be_bytes(counter).wrapping_add(1);
        patch[6..10].copy_from_slice(&next.to_be_bytes());
        f.write_all_at(&patch, WRITE_VERSION)?;
        f.sync_all()?;
        out.stamped = true;
    }

    out.sidecars_removed = remove_sidecars(path);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn wal_db(dir: &Path) -> std::path::PathBuf {
        let p = dir.join("m.sqlite");
        let conn = Connection::open(&p).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
            .unwrap();
        conn.execute("INSERT INTO t (v) VALUES ('a')", []).unwrap();
        drop(conn);
        p
    }

    #[test]
    fn a_wal_image_is_converted_and_stays_readable() {
        let dir = tempfile::tempdir().unwrap();
        let p = wal_db(dir.path());
        assert_eq!(
            journal_bytes(&p),
            Some((2, 2)),
            "fixture must actually be WAL-headed"
        );

        let fix = ensure_rollback_journal(&p).unwrap();
        assert!(fix.stamped);
        assert_eq!(journal_bytes(&p), Some((1, 1)));

        // The whole point: it is still a working database afterwards.
        let conn =
            Connection::open_with_flags(&p, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let ok: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ok, "ok");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn the_change_counter_advances_so_readers_drop_their_cache() {
        let dir = tempfile::tempdir().unwrap();
        let p = wal_db(dir.path());
        let before = {
            let f = std::fs::File::open(&p).unwrap();
            let mut b = [0u8; 4];
            f.read_exact_at(&mut b, 24).unwrap();
            u32::from_be_bytes(b)
        };
        ensure_rollback_journal(&p).unwrap();
        let after = {
            let f = std::fs::File::open(&p).unwrap();
            let mut b = [0u8; 4];
            f.read_exact_at(&mut b, 24).unwrap();
            u32::from_be_bytes(b)
        };
        assert_eq!(after, before.wrapping_add(1));
    }

    #[test]
    fn reserved_header_bytes_20_to_23_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let p = wal_db(dir.path());
        let before = {
            let f = std::fs::File::open(&p).unwrap();
            let mut b = [0u8; 4];
            f.read_exact_at(&mut b, 20).unwrap();
            b
        };
        ensure_rollback_journal(&p).unwrap();
        let after = {
            let f = std::fs::File::open(&p).unwrap();
            let mut b = [0u8; 4];
            f.read_exact_at(&mut b, 20).unwrap();
            b
        };
        // Byte 20 is the reserved-space-per-page size. Corrupting it silently changes the usable
        // page payload and every b-tree read goes wrong.
        assert_eq!(before, after);
    }

    #[test]
    fn it_is_idempotent_and_reaps_stale_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let p = wal_db(dir.path());
        ensure_rollback_journal(&p).unwrap();

        let second = ensure_rollback_journal(&p).unwrap();
        assert!(
            !second.stamped,
            "already-legacy headers must not be rewritten"
        );

        // A reader that opened during the restore window leaves these behind.
        std::fs::write(p.with_extension("sqlite-wal"), b"stale").unwrap();
        std::fs::write(p.with_extension("sqlite-shm"), b"stale").unwrap();
        let third = ensure_rollback_journal(&p).unwrap();
        assert_eq!(third.sidecars_removed, 2);
        assert!(!p.with_extension("sqlite-wal").exists());
    }

    #[test]
    fn a_missing_mirror_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let fix = ensure_rollback_journal(&dir.path().join("nope.sqlite")).unwrap();
        assert!(!fix.changed());
    }
}
