//! noop-liters-sink — the receive half of NOOP's delta sync.
//!
//! What this is, in one sentence: a **writable liters HTTP replication endpoint** bound to
//! loopback, plus a loop that materializes everything pushed into it onto `mirror.sqlite`.
//!
//! What it deliberately is NOT: a protocol. Every byte on the wire is handled by
//! `liters_storage::HttpServer`, whose grammar is specified normatively in the liters repo's
//! `docs/http-protocol.md` — `PUT /ltx/{level}/{min:016x}-{max:016x}.ltx`, `DELETE` of the same,
//! `DELETE /all`, `GET /ltx/{level}` listings, `GET /stream`. Writer leases, TXID monotonicity, the
//! bounded drain on every error path, the byte-identical idempotent re-push check: all of that is
//! liters' code, tested by liters' suite against a Go litestream oracle. This binary supplies
//! configuration, a disk preflight, a corpse sweeper, and a status file. That is the entire
//! contribution, and keeping it that small is the point — see docs/SYNC_BUILD_VS_BUY.md, which
//! chose "buy the idea AND the implementation" over a third hand-rolled protocol.
//!
//! Topology on the Fly machine:
//!
//! ```text
//!   phone (liters Writer, background URLSession)
//!     │  PUT https://vk-noop-cloud.fly.dev/liters/ltx/0/…
//!     ▼
//!   Express  /liters/*  — bearer auth, disk preflight, streaming reverse proxy, prefix stripped
//!     │  http://127.0.0.1:9736/ltx/0/…
//!     ▼
//!   this binary
//!     ├─ HttpServer{writable:true, auth_token}  ──►  /data/ltx-bucket   (litestream `file` layout)
//!     └─ Replica::sync()                        ──►  /data/mirror.sqlite   (in place)
//!                                                        ▲
//!                                            19 MCP read call sites, unchanged
//! ```
//!
//! The mirror liters produces is a plain **rollback-journal** SQLite file — `apply_spooled` stamps
//! header bytes 18/19 to `0x01` and randomizes the change counter at 24..28 so other connections
//! invalidate their page cache. `better-sqlite3` opens it exactly as it does today. There is no
//! `-wal`, no `-shm`, and no new reader configuration.

mod config;
mod mirrorfix;
mod space;
mod status;
mod sweep;

use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use config::Config;
use liters::{
    CancelToken, DirReplicaClient, Error, IntegrityCheck, Replica, ReplicaClient, ReplicaOptions,
    Txid, SNAPSHOT_LEVEL,
};
use liters_storage::{HttpServer, HttpServerOptions};
use status::Status;

/// Set by the signal handler ONLY. Everything else observes it; a handler must not touch a
/// CancelToken, a Mutex, or an allocator.
static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_sig: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
}

fn install_signal_handlers() {
    let h = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
    unsafe {
        libc::signal(libc::SIGTERM, h);
        libc::signal(libc::SIGINT, h);
        // A peer that vanishes mid-write must not kill the process.
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn log(kind: &str, msg: &str) {
    // One line, prefixed: Node pipes this straight into its own stdout, where it sits next to
    // Express's logs in `fly logs`.
    println!("liters-sink {kind}: {msg}");
}

/// Highest TXID anywhere in the bucket. `0` means empty — a wipe-then-reseed window, which is
/// explicitly NOT divergence (docs/http-protocol.md, `/stream` ping semantics).
fn bucket_max(client: &dyn ReplicaClient) -> u64 {
    let mut max = 0u64;
    for level in 0..=SNAPSHOT_LEVEL {
        if let Ok(files) = client.ltx_files(level, Txid(0), false) {
            for f in files {
                max = max.max(f.max_txid.0);
            }
        }
    }
    max
}

fn dir_bytes(dir: &std::path::Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            match e.metadata() {
                Ok(m) if m.is_dir() => total += dir_bytes(&e.path()),
                Ok(m) => total += m.len(),
                Err(_) => {}
            }
        }
    }
    total
}

struct Sink {
    cfg: Config,
    replica: Replica,
    client: Arc<DirReplicaClient>,
    st: Status,
    cancel: CancelToken,
}

impl Sink {
    fn new(cfg: Config) -> Result<Sink, String> {
        std::fs::create_dir_all(&cfg.bucket_dir).map_err(|e| format!("bucket dir: {e}"))?;
        std::fs::create_dir_all(&cfg.tmp_dir).map_err(|e| format!("tmp dir: {e}"))?;
        if let Some(parent) = cfg.mirror_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("data dir: {e}"))?;
        }

        // NOT cosmetic. `liters_storage::http::unlinked_temp_file` spools every PUT body into
        // `std::env::temp_dir()`, which on a Fly machine is the container's root filesystem — a few
        // GB, shared with the Node install, and NOT the 10.5 GB data volume. A snapshot push (the
        // `snapshotting = true` path, i.e. the whole database as one LTX) would spool hundreds of MB
        // there and fill the rootfs while the volume sat empty. Pointing TMPDIR at the volume puts
        // the spool where the preflight can actually see it.
        std::env::set_var("TMPDIR", &cfg.tmp_dir);

        let replica = Replica::open(
            cfg.mirror_path.clone(),
            Box::new(DirReplicaClient::new(cfg.bucket_dir.clone())),
            ReplicaOptions {
                // ALWAYS None, and the sink runs the check itself instead — see `verify_restore`.
                // liters' own post-restore `quick_check` opens the mirror read-only *before* the
                // journal-mode fixup can run, which on a WAL-headed restore image re-creates the
                // exact `-wal`/`-shm` sidecars `full_restore` deleted three lines earlier. Running
                // it after the fixup is the same check with none of that.
                integrity_check: IntegrityCheck::None,
                // The whole reason the lock exists: MCP readers live in another process
                // (better-sqlite3 in Node), and POSIX record locks are the only thing that stops a
                // reader observing a half-applied page range. Never turn this off.
                use_file_locks: true,
                lock_timeout: cfg.lock_timeout,
                // Deliberately false. auto_reset would silently re-restore the whole 766 MB mirror
                // when the bucket looks reseeded — including in the case where /ingest legitimately
                // replaced the mirror underneath us. Divergence should be LOUD and should be
                // resolved by an explicit reset, not by a background thread deciding to rewrite the
                // database every MCP tool is reading.
                auto_reset: false,
            },
        );
        let client = Arc::new(DirReplicaClient::new(cfg.bucket_dir.clone()));
        // `space_ok` starts true so that a round which never reaches the preflight — an adoption
        // refusal, say — reports the failure it actually had instead of "no disk space". Exit codes
        // are the contract for `--apply-once`; one of them being wrong sends an operator to the
        // wrong problem.
        let st = Status {
            ok: true,
            space_ok: true,
            started_at_ms: now_ms(),
            min_free_bytes: cfg.min_free_bytes,
            ..Status::default()
        };
        Ok(Sink {
            cfg,
            replica,
            client,
            st,
            cancel: CancelToken::new(),
        })
    }

    /// Where an existing, non-liters mirror is kept when the sink takes the path over.
    fn aside_path(&self) -> std::path::PathBuf {
        let mut p = self.cfg.mirror_path.as_os_str().to_owned();
        p.push(".pre-liters");
        std::path::PathBuf::from(p)
    }

    /// Make the mirror path restorable, or explain why it is not.
    ///
    /// `Replica::sync` refuses outright when `mirror.sqlite` exists but `mirror.sqlite-txid` does
    /// not — it cannot know what TXID an arbitrary database is at, and materializing onto an unknown
    /// file would splice two lineages. Correct for a library. But on THIS server that state is the
    /// normal starting condition: `mirror.sqlite` is already there, put there by `/ingest`'s
    /// `rename(2)` swap, and it has never heard of liters. Without this, switching the phone to the
    /// liters path would leave replication permanently stalled on
    /// `replica exists but has no -txid sidecar` while `/status` looked otherwise healthy.
    ///
    /// So the takeover is explicit and reversible:
    /// - the incumbent mirror is **renamed aside**, never deleted, to a fixed
    ///   `mirror.sqlite.pre-liters` (same filesystem: free, no bytes copied, no preflight);
    /// - the restore that follows must satisfy liters' own plan (an unbroken chain back to TXID 1,
    ///   which only exists if the phone pushed a snapshot) and then this sink's `quick_check`;
    /// - if either fails, `rollback_adoption` puts the incumbent straight back.
    ///
    /// A second, later adoption (a crash between `full_restore`'s rename and its `-txid` write)
    /// finds the aside file already occupied and discards the torn image instead of overwriting the
    /// one good copy.
    fn prepare(&mut self, position: u64, bucket_max: u64) -> Result<bool, String> {
        let mirror_exists = self.cfg.mirror_path.exists();

        // A sidecar describing a file that is gone. Nothing can be resumed from it.
        if !mirror_exists && position > 0 {
            let mut p = self.cfg.mirror_path.as_os_str().to_owned();
            p.push("-txid");
            let _ = std::fs::remove_file(std::path::PathBuf::from(p));
            log(
                "reset",
                "removed a -txid sidecar whose mirror no longer exists",
            );
            return Ok(false);
        }

        if position > 0 || !mirror_exists || bucket_max == 0 {
            return Ok(false); // normal steady state, a fresh volume, or an idle empty bucket
        }

        if !self.cfg.adopt_existing_mirror {
            return Err(format!(
                "mirror {:?} exists but is not a liters replica (no -txid sidecar) and \
                 LITERS_ADOPT_EXISTING_MIRROR is off, so replication is stopped rather than \
                 taking over a mirror it did not create",
                self.cfg.mirror_path
            ));
        }

        let aside = self.aside_path();
        if aside.exists() {
            log(
                "adopt",
                &format!(
                    "discarding an unpositioned mirror; {aside:?} already holds the incumbent"
                ),
            );
            std::fs::remove_file(&self.cfg.mirror_path)
                .map_err(|e| format!("remove mirror: {e}"))?;
        } else {
            log("adopt", &format!("moving the incumbent mirror aside to {aside:?} before restoring from the bucket"));
            std::fs::rename(&self.cfg.mirror_path, &aside)
                .map_err(|e| format!("rename aside: {e}"))?;
        }
        for suffix in ["-wal", "-shm"] {
            let mut p = self.cfg.mirror_path.as_os_str().to_owned();
            p.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(p));
        }
        Ok(true)
    }

    /// Undo a `prepare` takeover whose restore did not work out.
    fn rollback_adoption(&self) {
        let aside = self.aside_path();
        if !self.cfg.mirror_path.exists() && aside.exists() {
            match std::fs::rename(&aside, &self.cfg.mirror_path) {
                Ok(()) => log(
                    "adopt-rollback",
                    "restore failed; the incumbent mirror is back in place",
                ),
                Err(e) => log(
                    "adopt-rollback-failed",
                    &format!("{e} — the mirror is MISSING and {aside:?} holds the only copy"),
                ),
            }
        }
    }

    /// One apply round. Returns true when the mirror moved.
    fn round(&mut self) -> bool {
        let max = bucket_max(self.client.as_ref());
        self.st.bucket_max = max;
        self.st.free_bytes = space::free_bytes(&self.cfg.tmp_dir).unwrap_or(0);
        self.st.bucket_bytes = dir_bytes(&self.cfg.bucket_dir);
        self.st.mirror_bytes = std::fs::metadata(&self.cfg.mirror_path)
            .map(|m| m.len())
            .unwrap_or(0);

        // BEFORE the up-to-date check, deliberately. `prepare` is what resolves the two states in
        // which the recorded position is a lie: a mirror with no sidecar (`/ingest`'s), and a
        // sidecar with no mirror. Both look "already current" on a naive `max <= position`
        // comparison — the second one especially, which is how a deleted mirror would sit there
        // never being rebuilt while the status file cheerfully reported the right TXID.
        let adopted = match self.prepare(self.replica.position().map(|t| t.0).unwrap_or(0), max) {
            Ok(a) => a,
            Err(e) => {
                self.st.ok = false;
                self.st.errors_total += 1;
                if self.st.last_error.as_deref() != Some(e.as_str()) {
                    log("error", &e);
                }
                self.st.last_error = Some(e);
                return false;
            }
        };

        let pos = self.replica.position().map(|t| t.0).unwrap_or(0);
        self.st.position = pos;

        if max <= pos && !adopted {
            self.st.ok = true;
            self.st.space_ok = true;
            self.st.lock_busy = false;
            self.st.last_error = None;
            return false;
        }

        // PREFLIGHT. See space.rs — this is the guard that keeps ENOSPC out of the live mirror.
        if let Some(need) = space::plan(
            self.client.as_ref(),
            &self.cfg.mirror_path,
            Txid(pos),
            self.cfg.min_free_bytes,
        ) {
            self.st.space_ok = need.fits();
            if !need.fits() {
                self.st.ok = false;
                self.st.errors_total += 1;
                let msg = format!(
                    "refusing apply: needs {} (spool {} + growth {} + {} headroom), {} free",
                    need.needed(),
                    need.spool_bytes,
                    need.growth_bytes,
                    need.min_free_bytes,
                    need.free_bytes
                );
                if self.st.last_error.as_deref() != Some(msg.as_str()) {
                    log("space", &msg);
                }
                self.st.last_error = Some(msg);
                return false;
            }
        } else {
            // statvfs unavailable — "unknown" is never "full".
            self.st.space_ok = true;
        }

        match self.replica.sync_with(&self.cancel) {
            Ok(r) => {
                // FIRST, before anything reports success and before the next reader arrives: the
                // mirror must present as a rollback-journal file. See mirrorfix.rs — on the restore
                // path liters leaves the source's WAL header in place, and a WAL-mode reader is not
                // serialized against the applier at all.
                self.fix_mirror();
                if r.restored {
                    if let Err(e) = self.verify_restore() {
                        // A restore that does not verify must not be published, and if it replaced
                        // an incumbent mirror that incumbent goes straight back.
                        if adopted {
                            let _ = std::fs::remove_file(&self.cfg.mirror_path);
                            self.rollback_adoption();
                        }
                        self.st.ok = false;
                        self.st.errors_total += 1;
                        log("error", &e);
                        self.st.last_error = Some(e);
                        return false;
                    }
                }
                self.st.ok = true;
                self.st.lock_busy = false;
                self.st.last_error = None;
                self.st.applies += 1;
                self.st.last_sync_at_ms = now_ms();
                self.st.position = r.to_txid.0;
                log(
                    "applied",
                    &format!(
                        "{} -> {} ({}) mirror={}B",
                        r.from_txid.0,
                        r.to_txid.0,
                        if r.restored { "restore" } else { "incremental" },
                        std::fs::metadata(&self.cfg.mirror_path)
                            .map(|m| m.len())
                            .unwrap_or(0)
                    ),
                );
                true
            }
            // EXPECTED, TRANSIENT, AND NOT AN OUTAGE. A reader in Node held the SQLite SHARED lock
            // longer than lock_timeout. Nothing was written — the lock is taken before the first
            // page — and the next round retries. It is counted separately from errors precisely so
            // that a busy afternoon of MCP queries does not read as replication being broken.
            Err(Error::LockBusy {
                ref lock,
                waited,
                holder_pid,
            }) => {
                self.st.ok = true;
                self.st.lock_busy = true;
                self.st.lock_busy_total += 1;
                let msg =
                    format!(
                    "reader holds the {lock} lock (waited {waited:?}, pid {}); retrying next round",
                    holder_pid.map(|p| p.to_string()).unwrap_or_else(|| "?".into())
                );
                log("lock-busy", &msg);
                self.st.last_error = Some(msg);
                false
            }
            Err(Error::Cancelled) => {
                if adopted {
                    self.rollback_adoption();
                }
                false
            }
            Err(e) => {
                if adopted {
                    self.rollback_adoption();
                }
                self.st.ok = false;
                self.st.lock_busy = false;
                self.st.errors_total += 1;
                let msg = e.to_string();
                log("error", &msg);
                self.st.last_error = Some(msg);
                false
            }
        }
    }

    fn publish(&self) {
        self.st.write(&self.cfg.status_path);
    }

    /// Enforce the rollback-journal invariant. Logged only when it actually does something, so a
    /// steady state is silent and a restore leaves one legible line.
    fn fix_mirror(&self) {
        match mirrorfix::ensure_rollback_journal(&self.cfg.mirror_path) {
            Ok(fix) if fix.changed() => log(
                "mirror-fixup",
                &format!(
                    "stamped rollback-journal header={} stale sidecars removed={}",
                    fix.stamped, fix.sidecars_removed
                ),
            ),
            Ok(_) => {}
            // Not fatal on its own, but it means the invariant every safety property rests on is
            // unverified, so it must be loud.
            Err(e) => log("mirror-fixup-failed", &e.to_string()),
        }
    }

    /// `PRAGMA quick_check` on a freshly restored mirror. Runs AFTER `fix_mirror`, so the read-only
    /// open cannot build a WAL index beside the file.
    ///
    /// Skipped entirely when `LITERS_INTEGRITY_CHECK=0` — a full scan of a 766 MB mirror is real
    /// I/O, and an operator restoring under time pressure may want it out of the way.
    fn verify_restore(&self) -> Result<(), String> {
        if !self.cfg.integrity_check {
            return Ok(());
        }
        let conn = rusqlite::Connection::open_with_flags(
            &self.cfg.mirror_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("post-restore open failed: {e}"))?;
        let verdict: String = conn
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(|e| format!("post-restore quick_check failed: {e}"))?;
        if verdict != "ok" {
            return Err(format!("post-restore quick_check: {verdict}"));
        }
        Ok(())
    }

    fn sweep(&mut self) {
        let s = sweep::sweep(
            &self.cfg.bucket_dir,
            &self.cfg.tmp_dir,
            self.cfg.tmp_sweep_age,
        );
        if s.removed > 0 {
            self.st.swept_total += s.removed;
            log(
                "swept",
                &format!("{} crash corpse(s), reclaimed {} bytes", s.removed, s.bytes),
            );
        }
    }
}

fn serve(mut sink: Sink) -> Result<(), String> {
    let opts = HttpServerOptions {
        // The receive side. Everything else on this server is read-only by default and stays so.
        writable: true,
        auth_token: Some(sink.cfg.auth_token.clone()),
        // Express strips `/liters` before proxying, so the mount sits at the root of what it sees.
        // Setting base_path here as well would double-strip — the two approaches are explicitly
        // mutually exclusive (docs/http-protocol.md, "Mount path").
        base_path: None,
        ..HttpServerOptions::default()
    };
    let mut server = HttpServer::bind(
        sink.cfg.addr.clone(),
        Arc::clone(&sink.client) as Arc<dyn ReplicaClient>,
        opts,
    )
    .map_err(|e| format!("bind {}: {e}", sink.cfg.addr))?;

    log(
        "ready",
        &format!(
            "listening on {} bucket={:?} mirror={:?}",
            server.local_addr(),
            sink.cfg.bucket_dir,
            sink.cfg.mirror_path
        ),
    );

    // Turns a signal into a CancelToken cancellation. The handler itself may only touch an atomic,
    // and a thread parked waiting for the replica lock only observes the token — so something has
    // to bridge the two, and it has to poll faster than a human notices a slow shutdown.
    let cancel = sink.cancel.clone();
    std::thread::Builder::new()
        .name("liters-sink-signal".into())
        .spawn(move || {
            while !STOP.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(50));
            }
            cancel.cancel();
        })
        .map_err(|e| format!("signal thread: {e}"))?;

    // Before the first round: a previous process may have been killed between `full_restore`'s
    // rename and its fixup, and a reader may have left a WAL index behind in the meantime.
    sink.fix_mirror();
    sink.sweep();
    sink.round();
    sink.publish();

    let mut last_sweep = Instant::now();
    while !STOP.load(Ordering::SeqCst) {
        // Sleep in slices so SIGTERM is observed promptly even with a long apply interval.
        let deadline = Instant::now() + sink.cfg.apply_interval;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || STOP.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(left.min(Duration::from_millis(50)));
        }
        if STOP.load(Ordering::SeqCst) {
            break;
        }
        if last_sweep.elapsed() >= Duration::from_secs(600) {
            sink.sweep();
            last_sweep = Instant::now();
        }
        sink.round();
        sink.publish();
    }

    log("stopping", "signal received");
    server.shutdown();
    sink.publish();
    Ok(())
}

/// `--apply-once`: one sweep + one apply round, print the status JSON, exit.
///
/// This exists for tests and for operators. It is how the contention test drives a real applier
/// against a real Node reader without a background process to race, and it is what you run by hand
/// when you want to know why the mirror is not moving.
///
/// Exit codes are the answer: 0 applied or already current, 3 reader contention, 4 no disk space,
/// 1 anything else.
fn apply_once(mut sink: Sink) -> ExitCode {
    sink.fix_mirror();
    sink.sweep();
    sink.round();
    sink.publish();
    println!("{}", sink.st.to_json());
    if sink.st.lock_busy {
        return ExitCode::from(3);
    }
    if !sink.st.space_ok {
        return ExitCode::from(4);
    }
    if !sink.st.ok {
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    install_signal_handlers();
    let once = std::env::args().any(|a| a == "--apply-once");

    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("liters-sink config: {e}");
            return ExitCode::from(2);
        }
    };
    let sink = match Sink::new(cfg) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("liters-sink startup: {e}");
            return ExitCode::from(2);
        }
    };

    if once {
        return apply_once(sink);
    }
    match serve(sink) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("liters-sink: {e}");
            ExitCode::from(2)
        }
    }
}
