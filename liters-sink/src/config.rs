//! Environment-derived configuration. Everything has a default except the bearer token, which is
//! deliberately required: a writable liters mount with no token accepts `DELETE /all` from anyone
//! who can reach it (docs/http-protocol.md, "Security"), and "anyone who can reach it" on a Fly
//! machine includes every other process in the container.

use std::path::PathBuf;
use std::time::Duration;

use crate::retention::Policy;

pub struct Config {
    /// Where the pushed LTX bucket lives — a plain directory in litestream's `file` layout.
    pub bucket_dir: PathBuf,
    /// The database the bucket materializes into. This is the SAME file the MCP read tools open.
    pub mirror_path: PathBuf,
    /// `host:port`. Loopback only in production: Express is the only thing that should reach this.
    pub addr: String,
    pub auth_token: String,
    /// Spool directory. Set as `TMPDIR` before the server binds — see `main.rs` for why this is
    /// not cosmetic.
    pub tmp_dir: PathBuf,
    /// Where the JSON status snapshot is written after every apply round.
    pub status_path: PathBuf,
    /// How often the apply loop looks for new LTX files.
    pub apply_interval: Duration,
    /// How long an apply waits for the replica-file lock before giving up with `LockBusy`.
    pub lock_timeout: Duration,
    /// Free bytes the volume must retain AFTER an apply completes. Mirrors `MIN_FREE_BYTES` on the
    /// Node side and defaults to the same 256 MB.
    pub min_free_bytes: u64,
    /// A bucket `*.ltx.<pid>-<seq>.tmp` older than this is a crash corpse (see `sweep.rs`).
    pub tmp_sweep_age: Duration,
    /// How much committed LTX history the bucket may hold. Distinct from `tmp_sweep_age` in every
    /// way that matters — see `retention.rs` and the 2026-08-03 outage it documents.
    pub retention: Policy,
    /// `PRAGMA quick_check` after a full restore. Cheap relative to a restore, and it is the only
    /// thing that distinguishes "restored" from "wrote 766 MB of plausible garbage".
    pub integrity_check: bool,
    /// Whether the sink may take over a `mirror.sqlite` it did not create — the one `/ingest` left
    /// behind. Default on, because the takeover renames the incumbent aside rather than deleting it
    /// and rolls back on any failure (see `Sink::prepare`). Turn it off to make the sink refuse
    /// loudly instead, which is the right setting if you are debugging a mirror you care about.
    pub adopt_existing_mirror: bool,
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn env_u64(name: &str, default: u64) -> Result<u64, String> {
    match std::env::var(name) {
        Err(_) => Ok(default),
        Ok(v) if v.is_empty() => Ok(default),
        Ok(v) => v
            .parse::<u64>()
            .map_err(|_| format!("{name}={v:?} is not a non-negative integer")),
    }
}

fn env_bool(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(v) => !matches!(v.as_str(), "" | "0" | "false" | "no" | "off"),
        Err(_) => default,
    }
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        let data_dir = env_path("DATA_DIR").unwrap_or_else(|| PathBuf::from("./data"));

        let auth_token = std::env::var("LITERS_SINK_TOKEN").unwrap_or_default();
        if auth_token.len() < 16 {
            return Err(
                "LITERS_SINK_TOKEN must be set (>=16 chars). A writable liters mount with \
                        no token accepts DELETE /all from anything that can open a socket to it."
                    .into(),
            );
        }
        // The token is interpolated into a request head verbatim by the reference client, so liters
        // itself requires visible ASCII. Reject here rather than at the first push.
        if !auth_token.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
            return Err("LITERS_SINK_TOKEN must be visible ASCII (0x21..0x7e), no spaces".into());
        }

        Ok(Config {
            bucket_dir: env_path("LITERS_BUCKET_DIR")
                .unwrap_or_else(|| data_dir.join("ltx-bucket")),
            mirror_path: env_path("LITERS_MIRROR_PATH")
                .unwrap_or_else(|| data_dir.join("mirror.sqlite")),
            addr: std::env::var("LITERS_SINK_ADDR").unwrap_or_else(|_| "127.0.0.1:9736".into()),
            auth_token,
            tmp_dir: env_path("LITERS_TMP_DIR").unwrap_or_else(|| data_dir.join("ltx-tmp")),
            status_path: env_path("LITERS_STATUS_PATH")
                .unwrap_or_else(|| data_dir.join("liters-sink-status.json")),
            apply_interval: Duration::from_millis(env_u64("LITERS_APPLY_INTERVAL_MS", 1_000)?),
            lock_timeout: Duration::from_millis(env_u64("LITERS_LOCK_TIMEOUT_MS", 5_000)?),
            min_free_bytes: env_u64("LITERS_MIN_FREE_BYTES", 268_435_456)?,
            tmp_sweep_age: Duration::from_millis(env_u64("LITERS_TMP_SWEEP_AGE_MS", 3_600_000)?),
            retention: Policy {
                enabled: env_bool("LITERS_LTX_RETENTION", true),
                keep: env_u64("LITERS_LTX_KEEP", Policy::default().keep)?,
                max_bytes: env_u64("LITERS_LTX_MAX_BYTES", 0)?,
                max_age: Duration::from_millis(env_u64("LITERS_LTX_MAX_AGE_MS", 0)?),
                grace: Duration::from_millis(env_u64("LITERS_LTX_PRUNE_GRACE_MS", 60_000)?),
            },
            integrity_check: env_bool("LITERS_INTEGRITY_CHECK", true),
            adopt_existing_mirror: env_bool("LITERS_ADOPT_EXISTING_MIRROR", true),
        })
    }
}
