//! End-to-end proof that the receive side speaks liters' protocol, not an approximation of it.
//!
//! These tests drive the **real built binary** (`CARGO_BIN_EXE_noop-liters-sink`) with a **real
//! liters `Writer`** on the other end — the same `Writer` the phone runs, over the same
//! `HttpReplicaClient`. Nothing here reimplements a request, parses a listing line, or asserts
//! against a hand-written fixture: if the wire format drifted, the client would fail to talk to the
//! server and the mirror would stay empty.
//!
//! What each test pins:
//! - `push_materializes_the_mirror` — the whole path: `PUT /ltx/0/…` → bucket → `Replica::sync()` →
//!   `mirror.sqlite`, byte-checked with `PRAGMA integrity_check` and row equality.
//! - `mirror_is_a_rollback_journal_file` — the mirror stays openable by `better-sqlite3` with
//!   `{readonly:true}` and no `-wal`/`-shm`. This is load-bearing: a read-only SQLite connection
//!   cannot *create* the `-shm` a WAL database needs, so a WAL-mode mirror would break all 19 MCP
//!   call sites with `unable to open database file`.
//! - `unauthenticated_push_is_rejected` — a writable mount without auth accepts `DELETE /all` from
//!   anyone who can open a socket.
//! - `interrupted_push_leaves_no_orphan` — the 2026-07-26 failure shape, checked directly.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use liters::{Writer, WriterOptions};
use liters_storage::{HttpClientOptions, HttpReplicaClient};
use rusqlite::Connection;

const TOKEN: &str = "test-token-0123456789abcdef";

struct Sink {
    child: Child,
    addr: String,
    #[allow(dead_code)]
    lines: Arc<Mutex<Vec<String>>>,
}

impl Drop for Sink {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Layout {
    dir: tempfile::TempDir,
}

impl Layout {
    fn new() -> Layout {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("bucket")).unwrap();
        std::fs::create_dir_all(dir.path().join("tmp")).unwrap();
        Layout { dir }
    }
    fn bucket(&self) -> PathBuf {
        self.dir.path().join("bucket")
    }
    fn mirror(&self) -> PathBuf {
        self.dir.path().join("mirror.sqlite")
    }
    fn status(&self) -> PathBuf {
        self.dir.path().join("status.json")
    }
    fn source(&self) -> PathBuf {
        self.dir.path().join("app.db")
    }

    fn command(&self, token: &str) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_noop-liters-sink"));
        c.env("LITERS_BUCKET_DIR", self.bucket())
            .env("LITERS_MIRROR_PATH", self.mirror())
            .env("LITERS_TMP_DIR", self.dir.path().join("tmp"))
            .env("LITERS_STATUS_PATH", self.status())
            .env("LITERS_SINK_TOKEN", token)
            .env("LITERS_SINK_ADDR", "127.0.0.1:0")
            .env("LITERS_APPLY_INTERVAL_MS", "100")
            .env("LITERS_TMP_SWEEP_AGE_MS", "0")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        c
    }

    /// Starts the sink and waits for its `ready` line, which carries the OS-assigned port.
    // The child is reaped by `impl Drop for Sink`, which clippy cannot see across the move into the
    // returned struct. The panic path below drops nothing only because it aborts the test process.
    #[allow(clippy::zombie_processes)]
    fn serve(&self, token: &str) -> Sink {
        self.serve_with(token, &[])
    }

    /// [`Layout::serve`] with extra environment, for tests that drive a non-default policy.
    #[allow(clippy::zombie_processes)]
    fn serve_with(&self, token: &str, extra: &[(&str, &str)]) -> Sink {
        let mut cmd = self.command(token);
        for (k, v) in extra {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        {
            // Drained on a thread: an undrained pipe eventually blocks the child mid-log, which
            // would look exactly like a replication hang.
            let lines = Arc::clone(&lines);
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    eprintln!("[sink] {line}");
                    lines.lock().unwrap().push(line);
                }
            });
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let found = {
                let seen = lines.lock().unwrap();
                seen.iter()
                    .find_map(|l| l.split("listening on ").nth(1))
                    .and_then(|rest| rest.split_whitespace().next())
                    .map(str::to_string)
            };
            if let Some(addr) = found {
                return Sink { child, addr, lines };
            }
            assert!(
                Instant::now() < deadline,
                "sink never reported a listening address"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// One-shot apply, for tests that want a deterministic round rather than a loop.
    fn apply_once(&self, token: &str) -> std::process::Output {
        self.command(token)
            .arg("--apply-once")
            .stdout(Stdio::piped())
            .output()
            .unwrap()
    }
}

fn create_source(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        .unwrap();
    conn
}

fn insert(conn: &Connection, tag: &str, n: usize) {
    for i in 0..n {
        conn.execute("INSERT INTO t (v) VALUES (?1)", [format!("{tag}-{i}")])
            .unwrap();
    }
}

fn rows(path: &Path) -> Vec<(i64, String)> {
    let conn =
        Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let ok: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        ok, "ok",
        "the materialized mirror must be a valid SQLite database"
    );
    let mut stmt = conn.prepare("SELECT id, v FROM t ORDER BY id").unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn writer_for(sink: &Sink, db: &Path, token: Option<&str>) -> liters::Result<Writer> {
    let client = HttpReplicaClient::with_options(
        format!("http://{}", sink.addr),
        HttpClientOptions {
            auth_token: token.map(str::to_string),
            io_timeout: Duration::from_secs(10),
            ..HttpClientOptions::default()
        },
    )
    .unwrap();
    Writer::open(db, Box::new(client), WriterOptions::default())
}

fn wait_for(mut f: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("timed out waiting for {what}");
}

fn status_field(status_path: &Path, key: &str) -> Option<u64> {
    let body = std::fs::read_to_string(status_path).ok()?;
    let needle = format!("\"{key}\":");
    let rest = body.split(&needle).nth(1)?;
    rest.trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()
}

/// Waits for a COMPLETED apply round, not merely for the mirror file to appear.
///
/// The distinction is the whole reason this helper exists. `full_restore` publishes the image by
/// `rename(2)` and the journal-mode fixup runs when `sync()` returns, so there is a real window —
/// milliseconds, on bootstrap only — in which `mirror.sqlite` exists, has every row, and still
/// carries the source's WAL header. A test that polls the file races that window; a test that polls
/// the status file observes the round the sink says it finished. Production has the same window and
/// mirrorfix.rs documents it; this helper exists so the test asserts the settled state rather than
/// accidentally sampling the transient one.
fn wait_for_round(status_path: &Path, min_position: u64) {
    wait_for(
        || status_field(status_path, "position").is_some_and(|p| p >= min_position),
        "a completed apply round",
    );
}

/// Committed level-0 segments, ascending — the files retention is allowed to have an opinion about.
fn l0_txids(bucket: &Path) -> Vec<u64> {
    let mut out: Vec<u64> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(bucket.join("ltx").join("0")) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some((_, max)) = ltx::parse_filename(&name) {
                out.push(max.0);
            }
        }
    }
    out.sort_unstable();
    out
}

fn bucket_tmp_files(bucket: &Path) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<String>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                if e.path().is_dir() {
                    walk(&e.path(), out);
                } else if e.file_name().to_string_lossy().ends_with(".tmp") {
                    out.push(e.file_name().to_string_lossy().into_owned());
                }
            }
        }
    }
    walk(bucket, &mut out);
    out
}

// ---------------------------------------------------------------------------

/// The whole point of the exercise: a liters `Writer` pushes deltas over HTTP and the mirror the
/// MCP tools read becomes a faithful copy — without a full-database upload anywhere in sight.
#[test]
fn push_materializes_the_mirror() {
    let l = Layout::new();
    let conn = create_source(&l.source());
    let sink = l.serve(TOKEN);
    let mut w = writer_for(&sink, &l.source(), Some(TOKEN)).unwrap();

    insert(&conn, "first", 50);
    let r = w.push().unwrap();
    assert!(
        r.uploaded >= 1,
        "the first push must upload at least one L0 file"
    );

    wait_for_round(&l.status(), r.txid.0);
    assert_eq!(rows(&l.mirror()).len(), 50);
    assert_eq!(rows(&l.mirror()), rows(&l.source()));

    // A SECOND push is the one that proves this is delta replication and not a re-upload: it must
    // land as its own L0 file and the mirror must move without the first 50 rows being resent.
    insert(&conn, "second", 25);
    let before_bucket = std::fs::read_dir(l.bucket().join("ltx").join("0"))
        .unwrap()
        .count();
    let r2 = w.push().unwrap();
    assert!(r2.txid > r.txid, "the second push must advance the TXID");
    wait_for_round(&l.status(), r2.txid.0);
    assert_eq!(rows(&l.mirror()).len(), 75);
    // The incremental path must leave the header alone — it is already legacy, and re-stamping
    // would mean the fixup is fighting liters rather than completing it.
    let header = std::fs::read(l.mirror()).unwrap();
    assert_eq!(
        (header[18], header[19]),
        (1, 1),
        "incremental applies stay rollback-journal"
    );
    let after_bucket = std::fs::read_dir(l.bucket().join("ltx").join("0"))
        .unwrap()
        .count();
    assert!(
        after_bucket > before_bucket,
        "the second push must add an L0 file, not rewrite one"
    );
    assert_eq!(rows(&l.mirror()), rows(&l.source()));

    // Nothing left behind on the success path.
    assert_eq!(bucket_tmp_files(&l.bucket()), Vec::<String>::new());

    let status: String = std::fs::read_to_string(l.status()).unwrap();
    assert!(status.contains("\"ok\":true"), "{status}");
    assert!(status.contains("\"lockBusy\":false"), "{status}");
}

/// `better-sqlite3` opens the mirror with `{readonly:true, fileMustExist:true}` and no `timeout`
/// override (src/mirror.ts:57). A read-only connection cannot create the `-shm` that a WAL database
/// requires, so a mirror in WAL mode would take out every MCP read tool at once. liters materializes
/// a rollback-journal file on purpose (`apply_spooled` stamps header bytes 18/19); this test is what
/// stops that from silently changing under us.
#[test]
fn mirror_is_a_rollback_journal_file() {
    let l = Layout::new();
    let conn = create_source(&l.source());
    let sink = l.serve(TOKEN);
    let mut w = writer_for(&sink, &l.source(), Some(TOKEN)).unwrap();
    insert(&conn, "x", 10);
    w.push().unwrap();
    wait_for_round(&l.status(), 1);
    assert_eq!(rows(&l.mirror()).len(), 10);

    let header = std::fs::read(l.mirror()).unwrap();
    assert_eq!(
        header[18], 1,
        "write version must be 1 (rollback journal), not 2 (WAL)"
    );
    assert_eq!(
        header[19], 1,
        "read version must be 1 (rollback journal), not 2 (WAL)"
    );

    let wal = l.mirror().with_extension("sqlite-wal");
    assert!(
        !wal.exists(),
        "a WAL sidecar next to the mirror would mean the mode changed"
    );

    // The literal open the MCP tools perform.
    let conn = Connection::open_with_flags(
        l.mirror(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 10);
}

/// `DELETE /all` wipes the bucket. The mount must never be reachable without the token.
#[test]
fn unauthenticated_push_is_rejected() {
    let l = Layout::new();
    let conn = create_source(&l.source());
    let sink = l.serve(TOKEN);
    insert(&conn, "x", 5);

    // No token at all.
    let err = writer_for(&sink, &l.source(), None)
        .and_then(|mut w| w.push())
        .expect_err("an unauthenticated push must not be accepted");
    assert!(
        format!("{err}").to_lowercase().contains("auth"),
        "expected an auth failure, got: {err}"
    );

    // Wrong token.
    let err = writer_for(&sink, &l.source(), Some("wrong-token-000000000000"))
        .and_then(|mut w| w.push())
        .expect_err("a wrong-token push must not be accepted");
    assert!(
        format!("{err}").to_lowercase().contains("auth"),
        "expected an auth failure, got: {err}"
    );

    // And nothing reached the bucket.
    assert!(
        !l.bucket().join("ltx").join("0").exists()
            || std::fs::read_dir(l.bucket().join("ltx").join("0"))
                .unwrap()
                .count()
                == 0
    );
}

/// The 2026-07-26 shape: a transfer that dies partway must not leave a file behind that the next
/// attempt has to work around. Here the sink is killed while the bucket holds a hand-planted
/// corpse, and the next start must reclaim it rather than accumulate beside it.
#[test]
fn interrupted_push_leaves_no_orphan() {
    let l = Layout::new();
    let conn = create_source(&l.source());
    {
        let sink = l.serve(TOKEN);
        let mut w = writer_for(&sink, &l.source(), Some(TOKEN)).unwrap();
        insert(&conn, "x", 10);
        w.push().unwrap();
        wait_for(|| l.mirror().exists(), "the mirror");
    } // sink killed, mid-life, like an OOM or a machine stop

    // Exactly what a SIGKILL during `DirReplicaClient::write_ltx_file` leaves: the unique-per-write
    // temp name that nothing in liters ever collects.
    let level0 = l.bucket().join("ltx").join("0");
    let corpse = level0.join("0000000000000009-0000000000000009.ltx.31337-0.tmp");
    std::fs::write(&corpse, vec![0u8; 4096]).unwrap();
    let corpse2 = level0.join("000000000000000a-000000000000000a.ltx.31338-0.tmp");
    std::fs::write(&corpse2, vec![0u8; 4096]).unwrap();
    assert_eq!(bucket_tmp_files(&l.bucket()).len(), 2);

    let out = l.apply_once(TOKEN);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert_eq!(
        bucket_tmp_files(&l.bucket()),
        Vec::<String>::new(),
        "restart must reclaim crash corpses, not accumulate beside them"
    );

    // Real replication history is untouched by the sweep.
    assert!(
        std::fs::read_dir(&level0).unwrap().count() > 0,
        "the sweep must not eat real LTX files"
    );
    assert_eq!(rows(&l.mirror()).len(), 10);
}

/// `--apply-once` is the operator/test surface. It must be a no-op — and say so — when the mirror
/// is already current, and it must not create a mirror out of an empty bucket.
#[test]
fn apply_once_is_a_noop_on_an_empty_bucket() {
    let l = Layout::new();
    let out = l.apply_once(TOKEN);
    assert!(out.status.success());
    let json = String::from_utf8_lossy(&out.stdout);
    assert!(json.contains("\"position\":0"), "{json}");
    assert!(json.contains("\"bucketMax\":0"), "{json}");
    assert!(
        !l.mirror().exists(),
        "an empty bucket must not conjure a mirror"
    );
}

/// The state every real deployment starts in: `/ingest` has already put a `mirror.sqlite` on the
/// volume and it has never heard of liters, so it has no `-txid` sidecar. `Replica::sync` refuses
/// that outright, which would leave replication permanently stalled the moment the phone switched
/// paths. The takeover must happen, and it must keep the incumbent.
#[test]
fn adopts_an_existing_ingest_mirror_without_destroying_it() {
    let l = Layout::new();
    let conn = create_source(&l.source());
    insert(&conn, "real", 30);

    // Fill the bucket first, with the sink stopped, so the mirror below is unambiguously the
    // incumbent rather than something liters produced.
    {
        let sink = l.serve(TOKEN);
        let mut w = writer_for(&sink, &l.source(), Some(TOKEN)).unwrap();
        w.push().unwrap();
        wait_for_round(&l.status(), 1);
    }

    // Now stage exactly what `/ingest` leaves behind: a real, valid SQLite database at the mirror
    // path with no `-txid` sidecar. Identified by a table name the bucket's database does not have,
    // so "was the incumbent preserved" is answerable without depending on byte layout.
    let mut txid = l.mirror().as_os_str().to_owned();
    txid.push("-txid");
    std::fs::remove_file(PathBuf::from(txid)).unwrap();
    std::fs::remove_file(l.mirror()).unwrap();
    {
        let c = Connection::open(l.mirror()).unwrap();
        c.execute_batch(
            "CREATE TABLE incumbent_from_ingest (x); INSERT INTO incumbent_from_ingest VALUES (1)",
        )
        .unwrap();
    }

    let out = l.apply_once(TOKEN);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );

    // The bucket is authoritative for the liters path, so the mirror is restored from it…
    assert_eq!(rows(&l.mirror()).len(), 30);
    // …and the incumbent is kept, not deleted. This is the difference between a takeover and a
    // data-loss event on a server whose mirror is the only server-side copy of the phone's data.
    let mut aside = l.mirror().as_os_str().to_owned();
    aside.push(".pre-liters");
    let aside = PathBuf::from(aside);
    assert!(
        aside.exists(),
        "the incumbent mirror must be preserved, not removed"
    );
    let kept =
        Connection::open_with_flags(&aside, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let n: i64 = kept
        .query_row("SELECT COUNT(*) FROM incumbent_from_ingest", [], |r| {
            r.get(0)
        })
        .expect("the aside file must still be the incumbent database");
    assert_eq!(n, 1);
}

/// With the takeover switched off, the sink must stop and say so rather than touch a mirror it did
/// not create.
#[test]
fn refuses_to_adopt_when_told_not_to() {
    let l = Layout::new();
    let conn = create_source(&l.source());
    insert(&conn, "real", 10);
    {
        let sink = l.serve(TOKEN);
        let mut w = writer_for(&sink, &l.source(), Some(TOKEN)).unwrap();
        w.push().unwrap();
        wait_for_round(&l.status(), 1);
    }
    let mut txid = l.mirror().as_os_str().to_owned();
    txid.push("-txid");
    std::fs::remove_file(PathBuf::from(txid)).unwrap();
    let incumbent = std::fs::read(l.mirror()).unwrap();

    let out = l
        .command(TOKEN)
        .arg("--apply-once")
        .env("LITERS_ADOPT_EXISTING_MIRROR", "0")
        .stdout(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let json = String::from_utf8_lossy(&out.stdout);
    assert!(
        json.contains("LITERS_ADOPT_EXISTING_MIRROR"),
        "the error must name the switch: {json}"
    );
    assert_eq!(
        std::fs::read(l.mirror()).unwrap(),
        incumbent,
        "the mirror must be untouched"
    );
}

/// A `-txid` sidecar whose mirror is gone describes nothing. It must be cleared rather than left to
/// make every future sync fail.
#[test]
fn clears_a_sidecar_whose_mirror_vanished() {
    let l = Layout::new();
    let conn = create_source(&l.source());
    insert(&conn, "x", 10);
    {
        let sink = l.serve(TOKEN);
        let mut w = writer_for(&sink, &l.source(), Some(TOKEN)).unwrap();
        w.push().unwrap();
        wait_for_round(&l.status(), 1);
    }
    std::fs::remove_file(l.mirror()).unwrap();

    let out = l.apply_once(TOKEN);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert_eq!(
        rows(&l.mirror()).len(),
        10,
        "the mirror must be rebuilt from the bucket"
    );
}

/// A token below the floor, or with a space in it, must stop the process at startup rather than
/// quietly serving a writable mount.
#[test]
fn refuses_to_start_without_a_usable_token() {
    let l = Layout::new();
    for bad in ["", "short", "has a space in it and is long enough"] {
        let out = l.apply_once(bad);
        assert_eq!(out.status.code(), Some(2), "token {bad:?} must be refused");
    }
}

/// The 2026-08-03 outage, prevented end to end.
///
/// Eight pushes against a bucket nothing prunes is what took `/data/ltx-bucket` to 7.8 GB across 27
/// segments and the volume to zero. With retention on, the sink drops applied history down to the
/// configured window while the round is running — and then, which is the part worth pinning, the
/// SAME `Writer` keeps pushing into the pruned bucket.
///
/// That last assertion is the production risk, not a formality. The phone's
/// `Writer::ensure_lineage_checked` compares the bucket's max L0 TXID against its own verified
/// position, so a pruner that took the head would present as a foreign writer and force a
/// rebaseline — a fresh full-database snapshot push, i.e. the 967 MB upload delta sync exists to
/// avoid, triggered by the mechanism meant to save disk. This test fails if that invariant is ever
/// relaxed.
#[test]
fn retention_bounds_the_bucket_without_breaking_the_pusher() {
    let l = Layout::new();
    let conn = create_source(&l.source());
    // keep=2 with no grace: a deterministic window, reached within one test rather than one day.
    let sink = l.serve_with(TOKEN, &[("LITERS_LTX_KEEP", "2"), ("LITERS_LTX_PRUNE_GRACE_MS", "0")]);
    let mut w = writer_for(&sink, &l.source(), Some(TOKEN)).unwrap();

    let mut last = 0u64;
    for i in 0..8 {
        insert(&conn, &format!("batch{i}"), 20);
        last = w.push().unwrap().txid.0;
        wait_for_round(&l.status(), last);
    }
    assert!(last >= 8, "expected one L0 file per push, got up to {last}");

    // The newest two, the head among them: eight pushes, a bounded bucket.
    wait_for(
        || l0_txids(&l.bucket()).len() <= 2,
        "retention to bound the bucket",
    );
    let kept = l0_txids(&l.bucket());
    assert_eq!(
        kept,
        vec![last - 1, last],
        "retention must keep a contiguous newest window, not an arbitrary subset"
    );
    assert!(
        status_field(&l.status(), "prunedTotal").unwrap() >= 5,
        "prunedTotal must count what left the volume"
    );
    assert_eq!(
        status_field(&l.status(), "sweptTotal").unwrap(),
        0,
        "no crash corpses existed; the corpse sweeper must not claim retention's work"
    );

    // The mirror is whole, and the pusher is undisturbed by the bucket having shrunk underneath it.
    assert_eq!(rows(&l.mirror()), rows(&l.source()));
    insert(&conn, "after-prune", 20);
    let r = w.push().unwrap();
    assert_eq!(
        r.uploaded, 1,
        "a rebaseline would re-upload the whole database instead of one delta"
    );
    wait_for_round(&l.status(), r.txid.0);
    assert_eq!(rows(&l.mirror()), rows(&l.source()));
}

/// The other half of the invariant: an unapplied segment is never a candidate, whatever the policy
/// says. With the mirror deleted the position is zero, so the entire chain is what a full restore
/// would plan across — retention must take nothing and the restore must still succeed.
#[test]
fn retention_never_touches_what_the_mirror_has_not_applied() {
    let l = Layout::new();
    let conn = create_source(&l.source());
    {
        let sink = l.serve(TOKEN);
        let mut w = writer_for(&sink, &l.source(), Some(TOKEN)).unwrap();
        for i in 0..5 {
            insert(&conn, &format!("b{i}"), 10);
            let r = w.push().unwrap();
            wait_for_round(&l.status(), r.txid.0);
        }
    }
    let before = l0_txids(&l.bucket());
    assert!(before.len() >= 5);

    // Position 0, and a policy that would otherwise strip the bucket to its head.
    std::fs::remove_file(l.mirror()).unwrap();
    let out = l
        .command(TOKEN)
        .arg("--apply-once")
        .env("LITERS_LTX_KEEP", "0")
        .env("LITERS_LTX_PRUNE_GRACE_MS", "0")
        .stdout(Stdio::piped())
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));

    assert_eq!(
        l0_txids(&l.bucket()),
        before,
        "an unapplied chain must survive intact"
    );
    let json = String::from_utf8_lossy(&out.stdout);
    assert!(json.contains("\"prunedTotal\":0"), "{json}");
    assert_eq!(rows(&l.mirror()).len(), 50, "the restore must still be possible");
}

/// The kill switch, proven off rather than assumed off.
#[test]
fn retention_can_be_turned_off_entirely() {
    let l = Layout::new();
    let conn = create_source(&l.source());
    let sink = l.serve_with(
        TOKEN,
        &[
            ("LITERS_LTX_RETENTION", "0"),
            ("LITERS_LTX_KEEP", "1"),
            ("LITERS_LTX_PRUNE_GRACE_MS", "0"),
        ],
    );
    let mut w = writer_for(&sink, &l.source(), Some(TOKEN)).unwrap();

    let mut last = 0u64;
    for i in 0..5 {
        insert(&conn, &format!("b{i}"), 10);
        last = w.push().unwrap().txid.0;
        wait_for_round(&l.status(), last);
    }
    assert_eq!(
        l0_txids(&l.bucket()).len(),
        last as usize,
        "with retention off the bucket must keep every segment"
    );
    assert_eq!(status_field(&l.status(), "prunedTotal").unwrap(), 0);
}
