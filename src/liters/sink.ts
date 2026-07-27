import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Config } from "../config.js";

/**
 * Supervisor for the `noop-liters-sink` child process.
 *
 * Node owns the sidecar's lifecycle rather than a process manager in the image, for one reason: the
 * container's `CMD` stays `node dist/server.js`. No supervisord, no shell wrapper, no second
 * PID-1 story to get wrong on a machine that VK restarts by hand during an incident.
 *
 * Killing the child abruptly is SAFE BY CONSTRUCTION, which is what makes this simple:
 * - an interrupted apply leaves the `{mirror}-txid` sidecar un-advanced, so the same LTX file
 *   re-applies from the start on the next round and rewrites every page it touched;
 * - an interrupted push leaves a `{name}.ltx.<pid>-<seq>.tmp` in the bucket, which the sink sweeps
 *   on its next start;
 * - an interrupted spool is an already-unlinked fd, reclaimed by the kernel.
 *
 * So there is no graceful-shutdown protocol to implement. SIGTERM, then SIGKILL after a grace
 * period, and the next start cleans up.
 */

export interface SinkHandle {
  /** Whether a child is currently running. */
  running(): boolean;
  /** Restarts since boot — a climbing number is the signal that the sidecar is crash-looping. */
  restarts(): number;
  lastExit(): { code: number | null; signal: string | null; at: number } | null;
  stop(): void;
}

/** Backoff between respawns. Capped so a persistent failure keeps retrying, quietly, forever. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/**
 * Starts and supervises the sink. Returns `null` — and logs why exactly once — when the feature is
 * off or cannot run. A missing binary is NOT fatal to the server: `/ingest` is the fallback and a
 * cloud that will not boot is worse than one missing an optional path.
 */
export function startLitersSink(cfg: Config): SinkHandle | null {
  // `?.` and not `.`: a Config assembled by hand — every test file builds one — has no `liters` key,
  // and a server that will not boot because an OPTIONAL subsystem's config is absent is a worse
  // server than one without the subsystem.
  if (!cfg.liters?.enabled) return null;

  if (!fs.existsSync(cfg.liters.binPath)) {
    console.error(
      `liters sink enabled but ${cfg.liters.binPath} is missing — page replication is DOWN, ` +
      `POST /ingest is unaffected. Set LITERS_SINK_BIN or rebuild the image with the Rust stage.`,
    );
    return null;
  }

  fs.mkdirSync(cfg.liters.bucketDir, { recursive: true });
  const tmpDir = path.join(path.dirname(cfg.liters.bucketDir), "ltx-tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  let child: ChildProcess | null = null;
  let stopped = false;
  let restarts = 0;
  let exit: { code: number | null; signal: string | null; at: number } | null = null;
  let timer: NodeJS.Timeout | null = null;

  const env = {
    ...process.env,
    DATA_DIR: cfg.dataDir,
    LITERS_BUCKET_DIR: cfg.liters.bucketDir,
    LITERS_MIRROR_PATH: cfg.mirrorPath,
    LITERS_TMP_DIR: tmpDir,
    LITERS_STATUS_PATH: cfg.liters.statusPath,
    LITERS_SINK_TOKEN: cfg.liters.sinkToken,
    LITERS_SINK_ADDR: cfg.liters.sinkAddr,
    // Deliberately the SAME floor Express enforces, so the two preflights cannot disagree about
    // whether the volume has room and leave a push accepted that the apply then refuses forever.
    LITERS_MIN_FREE_BYTES: String(cfg.minFreeBytes),
  };

  const spawnOnce = () => {
    if (stopped) return;
    const c = spawn(cfg.liters.binPath, [], { env, stdio: ["ignore", "pipe", "pipe"] });
    child = c;

    // Line-forwarded into this process's stdout so `fly logs` shows one stream, in order.
    const forward = (stream: NodeJS.ReadableStream, to: (s: string) => void) => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line) to(line);
        }
        // A single pathological line must not grow without bound.
        if (buf.length > 64 * 1024) buf = buf.slice(-8192);
      });
    };
    forward(c.stdout!, (l) => console.log(l));
    forward(c.stderr!, (l) => console.error(l));

    c.on("exit", (code, signal) => {
      child = null;
      exit = { code, signal, at: Date.now() };
      if (stopped) return;
      const wait = BACKOFF_MS[Math.min(restarts, BACKOFF_MS.length - 1)];
      restarts++;
      console.error(`liters sink exited (code=${code} signal=${signal}); restarting in ${wait}ms (restart #${restarts})`);
      timer = setTimeout(spawnOnce, wait);
      timer.unref?.();
    });

    // ENOENT / EACCES on spawn. 'exit' does not fire, so the restart has to be armed here too.
    c.on("error", (e) => {
      console.error(`liters sink failed to start: ${e.message}`);
    });
  };

  spawnOnce();

  return {
    running: () => child !== null && child.exitCode === null,
    restarts: () => restarts,
    lastExit: () => exit,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      const c = child;
      if (!c) return;
      c.kill("SIGTERM");
      // Safe by construction (see the module note): nothing the child was doing needs to finish.
      const k = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* already gone */ } }, 3_000);
      k.unref?.();
    },
  };
}
