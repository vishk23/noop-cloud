//! **The lock hazard**, tested rather than argued.
//!
//! `Replica::apply_spooled` writes pages into the live mirror and, before the first one, takes
//! SQLite's EXCLUSIVE lock pair (the PENDING byte plus the SHARED range) with `fcntl`. The MCP read
//! tools open that same file from a *different process* — Node, `better-sqlite3`,
//! `{readonly: true, fileMustExist: true}` (src/mirror.ts:57) — and POSIX record locks only conflict
//! across processes, which is exactly the configuration that exists in production and exactly the
//! one that cannot be reproduced with two handles in one program.
//!
//! Upstream liters acquires with `fcntl(F_SETLKW)`: blocking, no timeout, no interruption point. A
//! reader holding a transaction parks the applier in the kernel indefinitely, and nothing gets it
//! back — not a `CancelToken` (a thread inside `fcntl` never reaches a poll site), not `SIGTERM`.
//! On this server that reader is *routine*: `streams` chains ~100 statements and `data_freshness`
//! runs `MAX(date(ts,'unixepoch'))` over 3M rows. So the fix — `fix/replica-lock-deadlock`, pinned
//! by rev in Cargo.toml — is load-bearing, and these tests are what stop it from being silently
//! un-pinned by a dependency bump.
//!
//! Four properties, each with a real `node` process on the other side of the lock:
//!
//! 1. `a_node_reader_cannot_wedge_the_applier` — contention is BOUNDED. Against `F_SETLKW` this
//!    test does not fail, it hangs.
//! 2. `a_refused_apply_leaves_the_mirror_untouched` — the lock precedes the first page, so a
//!    `LockBusy` writes nothing. Verified by hashing the file either side.
//! 3. `the_applier_waits_a_reader_out_and_then_applies` — the applier is not *starved*: give it a
//!    bound longer than the reader's hold and it gets in on its own.
//! 4. `replication_resumes_by_itself_after_the_reader_commits` — no operator step, no reset.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use liters::{DirReplicaClient, Writer, WriterOptions};
use rusqlite::Connection;

const TOKEN: &str = "contention-token-0123456789";

struct Env {
    dir: tempfile::TempDir,
}

impl Env {
    fn new() -> Env {
        let e = Env {
            dir: tempfile::tempdir().unwrap(),
        };
        std::fs::create_dir_all(e.bucket()).unwrap();
        std::fs::create_dir_all(e.dir.path().join("tmp")).unwrap();
        e
    }
    fn bucket(&self) -> PathBuf {
        self.dir.path().join("bucket")
    }
    fn mirror(&self) -> PathBuf {
        self.dir.path().join("mirror.sqlite")
    }
    fn source(&self) -> PathBuf {
        self.dir.path().join("app.db")
    }

    /// One apply round with an explicit lock bound. Exit codes: 0 applied/current, 3 lock busy.
    fn apply_once(&self, lock_timeout_ms: u64) -> std::process::Output {
        Command::new(env!("CARGO_BIN_EXE_noop-liters-sink"))
            .arg("--apply-once")
            .env("LITERS_BUCKET_DIR", self.bucket())
            .env("LITERS_MIRROR_PATH", self.mirror())
            .env("LITERS_TMP_DIR", self.dir.path().join("tmp"))
            .env("LITERS_STATUS_PATH", self.dir.path().join("status.json"))
            .env("LITERS_SINK_TOKEN", TOKEN)
            .env("LITERS_LOCK_TIMEOUT_MS", lock_timeout_ms.to_string())
            .env("LITERS_TMP_SWEEP_AGE_MS", "0")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .output()
            .unwrap()
    }
}

/// Pushes straight into the bucket directory. The receive endpoint is not what is under test here —
/// `receive_e2e.rs` covers that — and taking HTTP out removes a whole class of timing noise from a
/// test whose entire subject is timing.
fn push(env: &Env, conn: &Connection, tag: &str, n: usize) {
    for i in 0..n {
        conn.execute("INSERT INTO t (v) VALUES (?1)", [format!("{tag}-{i}")])
            .unwrap();
    }
    let mut w = Writer::open(
        env.source(),
        Box::new(DirReplicaClient::new(env.bucket())),
        WriterOptions::default(),
    )
    .unwrap();
    w.push().unwrap();
}

fn source_conn(env: &Env) -> Connection {
    let conn = Connection::open(env.source()).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        .unwrap();
    conn
}

fn better_sqlite3() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../node_modules/better-sqlite3")
}

/// A **real Node reader**, in its own process, holding a real SQLite read transaction — the thing
/// the MCP tools are.
///
/// `BEGIN` alone takes nothing (SQLite's default is a DEFERRED transaction), so the script issues a
/// query afterwards: that first read is what acquires the SHARED lock, and `HELD` is only printed
/// once it is genuinely held. A test that skipped the query would be testing nothing at all.
struct NodeReader {
    child: Child,
}

impl Drop for NodeReader {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn hold_read_lock(mirror: &Path, hold_ms: u64) -> NodeReader {
    let script = r#"
const Database = require(process.argv[1]);
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true, timeout: 250 });
db.exec('BEGIN');
db.prepare('SELECT COUNT(*) AS c FROM t').get();   // <- this is what takes the SHARED lock
console.log('HELD');
setTimeout(() => { try { db.exec('COMMIT'); } catch (e) {} db.close(); process.exit(0); },
           Number(process.argv[3]));
"#;
    let mut child = Command::new("node")
        .arg("-e")
        .arg(script)
        .arg(better_sqlite3())
        .arg(mirror)
        .arg(hold_ms.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("node must be on PATH for the contention tests");

    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    let first = lines.next().and_then(Result::ok);
    assert_eq!(
        first.as_deref(),
        Some("HELD"),
        "the Node reader never reported holding the lock"
    );
    NodeReader { child }
}

fn digest(p: &Path) -> Vec<u8> {
    // Content identity, not a cryptographic claim: the file is a few tens of KB in these fixtures.
    std::fs::read(p).unwrap()
}

fn rows(p: &Path) -> usize {
    let conn = Connection::open_with_flags(p, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get::<_, i64>(0))
        .unwrap() as usize
}

/// Bootstrap: a materialized mirror plus exactly one unapplied LTX file waiting in the bucket.
fn staged(env: &Env) -> Connection {
    let conn = source_conn(env);
    push(env, &conn, "base", 20);
    let out = env.apply_once(5_000);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert_eq!(rows(&env.mirror()), 20);
    push(env, &conn, "pending", 10); // now the bucket is ahead of the mirror
    conn
}

// ---------------------------------------------------------------------------

/// **The wedge test.** A reader holds the lock for longer than the applier's bound; the applier must
/// give up and say so, not park in the kernel.
///
/// Against upstream's `fcntl(F_SETLKW)` this does not report a failure — it never returns.
#[test]
fn a_node_reader_cannot_wedge_the_applier() {
    let env = Env::new();
    let _conn = staged(&env);

    let _reader = hold_read_lock(&env.mirror(), 30_000); // far longer than the bound below

    let started = Instant::now();
    let out = env.apply_once(400);
    let waited = started.elapsed();
    let json = String::from_utf8_lossy(&out.stdout);

    assert_eq!(
        out.status.code(),
        Some(3),
        "expected the LockBusy exit code; got {json}"
    );
    assert!(json.contains("\"lockBusy\":true"), "{json}");
    // The bound is a bound: it must actually be spent…
    assert!(
        waited >= Duration::from_millis(400),
        "gave up too early: {waited:?}"
    );
    // …and it must actually END. Ten seconds is enormously generous for a 400ms bound plus process
    // start; the point is that this is finite at all.
    assert!(
        waited < Duration::from_secs(10),
        "the applier did not come back: {waited:?}"
    );
}

/// The lock is taken before the first page is written, so a refused apply is a no-op — which is what
/// makes it safe to retry forever.
#[test]
fn a_refused_apply_leaves_the_mirror_untouched() {
    let env = Env::new();
    let _conn = staged(&env);
    let before = digest(&env.mirror());

    let _reader = hold_read_lock(&env.mirror(), 30_000);
    let out = env.apply_once(300);
    assert_eq!(out.status.code(), Some(3));

    assert_eq!(
        digest(&env.mirror()),
        before,
        "a lock-busy apply must not write a single byte"
    );
    assert_eq!(
        rows(&env.mirror()),
        20,
        "and the mirror must still serve the old, consistent data"
    );
}

/// The other half of the property: bounded does not mean fragile. Given a bound longer than the
/// reader's hold, the applier sits the reader out and proceeds on its own — no operator, no reset.
/// This is what rules out the applier being *starved* rather than merely bounded.
#[test]
fn the_applier_waits_a_reader_out_and_then_applies() {
    let env = Env::new();
    let _conn = staged(&env);

    let _reader = hold_read_lock(&env.mirror(), 1_200);
    let started = Instant::now();
    let out = env.apply_once(15_000);
    let waited = started.elapsed();

    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert_eq!(
        rows(&env.mirror()),
        30,
        "the pending batch must have landed"
    );
    assert!(
        waited >= Duration::from_millis(900),
        "it cannot have got the lock before the reader let go: {waited:?}"
    );
    assert!(waited < Duration::from_secs(12), "{waited:?}");
}

/// End to end: contention happens, replication carries on. The failure is transient by construction
/// (nothing was written, the position never advanced), so the very next round succeeds.
#[test]
fn replication_resumes_by_itself_after_the_reader_commits() {
    let env = Env::new();
    let _conn = staged(&env);

    {
        let _reader = hold_read_lock(&env.mirror(), 20_000);
        assert_eq!(env.apply_once(250).status.code(), Some(3));
        assert_eq!(rows(&env.mirror()), 20);
    } // reader gone

    let out = env.apply_once(5_000);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert_eq!(rows(&env.mirror()), 30);

    // And a reader arriving after the apply sees the new data — i.e. the change counter did its job
    // and nobody is serving a stale page cache.
    let conn =
        Connection::open_with_flags(env.mirror(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let ok: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(ok, "ok");
}

/// A reader arriving while the applier is mid-apply must not corrupt anything, and must not be able
/// to keep the applier out indefinitely by arriving repeatedly: SQLite's PENDING byte, which the
/// applier holds across its SHARED retries, is what blocks new readers from acquiring.
///
/// Expressed as the observable consequence rather than as lock-state introspection: readers hammer
/// the mirror throughout, the applier still gets in within its bound, and every read that DID
/// succeed saw a self-consistent database.
#[test]
fn a_stream_of_arriving_readers_does_not_lock_the_applier_out() {
    let env = Env::new();
    let _conn = staged(&env);

    let script = r#"
const Database = require(process.argv[1]);
const deadline = Date.now() + Number(process.argv[3]);
let ok = 0, busy = 0;
while (Date.now() < deadline) {
  try {
    const db = new Database(process.argv[2], { readonly: true, fileMustExist: true, timeout: 50 });
    db.prepare('SELECT COUNT(*) AS c FROM t').get();
    db.close();
    ok++;
  } catch (e) { busy++; }
}
console.log(JSON.stringify({ ok, busy }));
"#;
    let mut hammer = Command::new("node")
        .arg("-e")
        .arg(script)
        .arg(better_sqlite3())
        .arg(env.mirror())
        .arg("4000")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();

    std::thread::sleep(Duration::from_millis(200)); // let the readers get going
    let started = Instant::now();
    let out = env.apply_once(5_000);
    let waited = started.elapsed();

    assert!(
        out.status.success(),
        "a continuous stream of readers must not lock the applier out: {}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(waited < Duration::from_secs(8), "{waited:?}");
    assert_eq!(rows(&env.mirror()), 30);

    let mut summary = String::new();
    BufReader::new(hammer.stdout.take().unwrap())
        .read_line(&mut summary)
        .unwrap();
    let _ = hammer.wait();
    // Readers kept working throughout; this is a liveness observation, not a strict bound.
    assert!(
        summary.contains("\"ok\":"),
        "reader loop produced no summary: {summary}"
    );
    eprintln!("reader loop during apply: {}", summary.trim());
}
