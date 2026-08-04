//! The JSON snapshot Node reads to answer `GET /status` and to run its own push preflight.
//!
//! Written with a FIXED temp sibling (`<path>.tmp`) and published by `rename(2)` — the same
//! discipline the rest of this server uses, and the reason a crash mid-write can leave at most one
//! stale byte-blob rather than an accumulating set of them.
//!
//! Hand-rolled rather than serde: six scalars and one error string do not justify a proc-macro
//! dependency in a binary whose whole point is being small enough to sit next to Node.

use std::io::Write;
use std::path::Path;

#[derive(Debug, Default, Clone)]
pub struct Status {
    /// False when the last apply round failed for any reason.
    pub ok: bool,
    /// `mirror.sqlite-txid`, i.e. what has actually been materialized.
    pub position: u64,
    /// Highest TXID the bucket holds. `position < bucket_max` = a sync is pending or blocked.
    pub bucket_max: u64,
    pub last_sync_at_ms: u64,
    pub last_error: Option<String>,
    /// Set when the last failure was reader contention rather than a fault. Distinguished because
    /// it is expected, transient, and self-clearing — it must not read as an outage.
    pub lock_busy: bool,
    pub applies: u64,
    pub lock_busy_total: u64,
    pub errors_total: u64,
    pub free_bytes: u64,
    pub bucket_bytes: u64,
    pub mirror_bytes: u64,
    /// Last preflight verdict. False = an apply is pending but the volume cannot hold it.
    pub space_ok: bool,
    /// Crash corpses reclaimed by `sweep.rs` — `.ltx.<pid>-<seq>.tmp` and orphaned spools ONLY.
    pub swept_total: u64,
    /// Committed LTX segments dropped by `retention.rs`. Deliberately a second counter rather than a
    /// bigger `swept_total`: on 2026-08-03 the bucket held 7.8 GB of real segments and zero corpses,
    /// so a truthful `sweptTotal: 0` read as "cleanup ran and found nothing wrong". One number
    /// answering two questions is how that happens.
    pub pruned_total: u64,
    pub pruned_bytes_total: u64,
    pub started_at_ms: u64,
    pub min_free_bytes: u64,
    /// Committed segments retained per level. Published so the active policy is visible next to the
    /// bucket size it is meant to bound, rather than only in the deploy's environment.
    pub ltx_keep: u64,
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

impl Status {
    pub fn to_json(&self) -> String {
        let err = match &self.last_error {
            // Bounded: an error string is a diagnostic, not a log sink, and this lands in every
            // /status response.
            Some(e) => format!("\"{}\"", escape(&e.chars().take(600).collect::<String>())),
            None => "null".into(),
        };
        format!(
            concat!(
                "{{\"ok\":{},\"position\":{},\"bucketMax\":{},\"lastSyncAtMs\":{},",
                "\"lastError\":{},\"lockBusy\":{},\"applies\":{},\"lockBusyTotal\":{},",
                "\"errorsTotal\":{},\"freeBytes\":{},\"bucketBytes\":{},\"mirrorBytes\":{},",
                "\"spaceOk\":{},\"sweptTotal\":{},\"prunedTotal\":{},\"prunedBytesTotal\":{},",
                "\"startedAtMs\":{},\"minFreeBytes\":{},\"ltxKeep\":{}}}"
            ),
            self.ok,
            self.position,
            self.bucket_max,
            self.last_sync_at_ms,
            err,
            self.lock_busy,
            self.applies,
            self.lock_busy_total,
            self.errors_total,
            self.free_bytes,
            self.bucket_bytes,
            self.mirror_bytes,
            self.space_ok,
            self.swept_total,
            self.pruned_total,
            self.pruned_bytes_total,
            self.started_at_ms,
            self.min_free_bytes,
            self.ltx_keep,
        )
    }

    /// Atomic publish. Never throws: a status write that fails must not take down replication.
    pub fn write(&self, path: &Path) {
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = std::path::PathBuf::from(tmp);
        let write = || -> std::io::Result<()> {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(self.to_json().as_bytes())?;
            f.write_all(b"\n")?;
            f.sync_all()?;
            std::fs::rename(&tmp, path)
        };
        if write().is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_is_parseable_and_escapes_hostile_errors() {
        let s = Status {
            ok: false,
            last_error: Some("disk \"I/O\" error\nline2\\x".into()),
            position: 12,
            ..Status::default()
        };
        let j = s.to_json();
        assert!(j.contains("\"position\":12"), "{j}");
        assert!(j.contains("\\\"I/O\\\""), "{j}");
        assert!(j.contains("\\n"), "{j}");
        assert!(
            !j.contains('\n'),
            "raw newlines would break a JSON line reader: {j}"
        );
    }

    /// The two reclaim mechanisms report separately. `sweptTotal: 0` alongside `prunedTotal: 24` is
    /// the reading that was unavailable on 2026-08-03, when one counter had to answer both "were
    /// there crash corpses?" and "is the bucket bounded?".
    #[test]
    fn swept_and_pruned_are_separate_fields() {
        let j = Status {
            swept_total: 0,
            pruned_total: 24,
            pruned_bytes_total: 6_700_000_000,
            ltx_keep: 3,
            ..Status::default()
        }
        .to_json();
        assert!(j.contains("\"sweptTotal\":0"), "{j}");
        assert!(j.contains("\"prunedTotal\":24"), "{j}");
        assert!(j.contains("\"prunedBytesTotal\":6700000000"), "{j}");
        assert!(j.contains("\"ltxKeep\":3"), "{j}");
    }

    #[test]
    fn write_publishes_atomically_and_leaves_no_temp() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("status.json");
        Status {
            ok: true,
            position: 7,
            ..Status::default()
        }
        .write(&p);
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.contains("\"position\":7"));
        assert!(!dir.path().join("status.json.tmp").exists());
    }
}
