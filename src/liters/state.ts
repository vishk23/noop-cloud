import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";

/**
 * Shared state between Express and the `noop-liters-sink` child: the status file it publishes, the
 * bucket it materializes from, and the one operation that has to be coordinated between the two
 * replication paths — invalidation.
 *
 * Nothing here speaks the liters protocol. That lives entirely in the Rust sink
 * (`liters-sink/src/main.rs`), which embeds `liters_storage::HttpServer`.
 */

export interface LitersStatus {
  ok: boolean;
  position: number;
  bucketMax: number;
  lastSyncAtMs: number;
  lastError: string | null;
  lockBusy: boolean;
  applies: number;
  lockBusyTotal: number;
  errorsTotal: number;
  freeBytes: number;
  bucketBytes: number;
  mirrorBytes: number;
  spaceOk: boolean;
  sweptTotal: number;
  startedAtMs: number;
  minFreeBytes: number;
}

export type LitersCfg = Pick<Config, "liters" | "mirrorPath">;

/**
 * The sink's last published round, or null when it has never published one.
 *
 * Deliberately tolerant: a torn or absent file is "no status", never a throw. This is read from
 * `/status` and `/healthz`, and a diagnostic that can fail is a diagnostic that disappears exactly
 * when it is needed — the 2026-07-26 lesson, applied to the one file that explains this subsystem.
 */
export function readStatus(cfg: LitersCfg): LitersStatus | null {
  try {
    const raw = fs.readFileSync(cfg.liters!.statusPath, "utf8");
    const j = JSON.parse(raw) as LitersStatus;
    return typeof j?.position === "number" ? j : null;
  } catch {
    return null;
  }
}

/**
 * Age in seconds of the status FILE itself, by mtime, or null when it does not exist.
 *
 * This is the liveness signal, and it is deliberately not derived from anything INSIDE the JSON.
 * The sink rewrites this file after every apply round (default 1 s) whether or not that round had
 * anything to do, so its mtime moves iff the loop is turning. The fields inside do not: an idle
 * sink that is perfectly healthy leaves `lastSyncAtMs` at 0 forever, because it has never had a
 * push to apply.
 *
 * Reading the field instead of the file is what made `/healthz` report "the apply loop is wedged"
 * against a sink that had been running happily for two minutes with an empty queue — a freshly
 * restored one, which is exactly when someone is watching. A health check that cries wolf on the
 * healthy case is worse than no health check, so the two are kept apart: `lastSyncAtMs` answers
 * "when did work last happen", this answers "is it still alive".
 */
export function statusAgeSeconds(cfg: LitersCfg): number | null {
  try {
    const st = fs.statSync(cfg.liters!.statusPath);
    return Math.max(0, Math.floor((Date.now() - st.mtimeMs) / 1000));
  } catch {
    return null;
  }
}

/** `{mirror}-txid` — liters' position sidecar. Its presence is what makes the mirror a replica. */
export function txidPath(cfg: LitersCfg): string {
  return `${cfg.mirrorPath}-txid`;
}

/** Bytes currently held by the pushed LTX bucket. */
export function bucketBytes(cfg: LitersCfg): number {
  const walk = (dir: string): number => {
    let total = 0;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try { total += e.isDirectory() ? walk(p) : fs.statSync(p).size; } catch { /* raced a sweep */ }
    }
    return total;
  };
  return walk(cfg.liters.bucketDir);
}

/**
 * Sever the liters lineage after `/ingest` has replaced the mirror.
 *
 * This is the one place the two replication paths touch, and getting the ORDER wrong loses data.
 *
 * `/ingest` publishes a brand-new mirror by `rename(2)`. To the sink that file is a stranger: the
 * `-txid` sidecar still names a TXID from the database that USED to be there, and the bucket still
 * holds the LTX chain that produced it. Leave both and the next sync applies stale pages onto a
 * fresh database — a silent merge of two lineages, which is the single worst outcome available in
 * this design.
 *
 * The order is **bucket first, sidecar second**, and it is safe at every interleaving:
 * - sink observes {bucket wiped, sidecar present}: bucket max 0 < position, so there is nothing to
 *   apply and the up-to-date check returns immediately. No write.
 * - sink observes {bucket wiped, sidecar gone}: position 0, bucket empty. No write.
 * - reversed order would allow {bucket intact, sidecar gone}, which is the adoption trigger — the
 *   sink would move the fresh `/ingest` mirror aside and restore the STALE bucket over it. Correct
 *   by luck rather than construction, and only because adoption preserves the incumbent. Do not
 *   reverse it.
 *
 * Wiping the bucket is not lossy: the phone's `Writer` re-baselines against an empty bucket by
 * pushing a fresh snapshot, which is exactly what should happen after a full `/ingest` anyway.
 *
 * Idempotent, best-effort, and never throws — it runs inside the ingest path, and an ingest that
 * succeeded must not be reported as failed because a cleanup did not.
 */
export function invalidateLitersLineage(cfg: LitersCfg): { bucketRemoved: boolean; sidecarRemoved: boolean } {
  let bucketRemoved = false;
  let sidecarRemoved = false;
  try {
    if (fs.existsSync(cfg.liters.bucketDir)) {
      fs.rmSync(cfg.liters.bucketDir, { recursive: true, force: true });
      bucketRemoved = true;
    }
  } catch { /* best-effort */ }
  try {
    if (fs.existsSync(txidPath(cfg))) {
      fs.rmSync(txidPath(cfg), { force: true });
      sidecarRemoved = true;
    }
  } catch { /* best-effort */ }
  // The applier's fixed-name spools. They are overwritten rather than accumulated, so this is
  // hygiene rather than a leak fix — but a `.apply.tmp` left from the previous lineage is confusing
  // to find on a volume during an incident.
  for (const suffix of [".apply.tmp", ".tmp", ".compact.tmp"]) {
    try { fs.rmSync(`${cfg.mirrorPath}${suffix}`, { force: true }); } catch { /* best-effort */ }
  }
  return { bucketRemoved, sidecarRemoved };
}
