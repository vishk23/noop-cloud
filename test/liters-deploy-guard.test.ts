import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import { createApp } from "../src/server.js";

// The 2026-07-28 outage in test form.
//
// Release v37 was built from `main`, which carried no liters code at all — the receive path lived
// only on `feat/liters-receive` and was never merged — while the `LITERS_SINK_ENABLED` secret stayed
// set and marked Deployed. Config said ON, code was GONE, and every route under /liters answered 404,
// including the `PUT /liters/ltx/0/...` the phone actually calls.
//
// It ran that way for 51 hours and nothing said so. /healthz answered `{ok:true}`, the Fly check
// passed, and the sink's own `errorsTotal` sat at 0 — not because pushes were succeeding but because
// the sidecar was not running and therefore never observed one failing. The phone could not tell
// either: its fallback treats a 404 exactly like a 503, so /ingest silently carried three full
// database uploads while the delta path was dead.
//
// Two guards, aimed at two different halves of "enabled and not serving":
//   1. the WRONG ARTIFACT — env says on, this build has no liters support at all. Fatal.
//   2. a DEGRADED RUNTIME — the code is here and switched on, but nothing is replicating. /healthz.

const dataDir = path.join(process.cwd(), "test/.tmp/liters-deploy-guard");

const baseCfg = (over: Record<string, unknown> = {}) => ({
  dataDir,
  mirrorPath: path.join(dataDir, "mirror.sqlite"),
  serverDbPath: path.join(dataDir, "server.sqlite"),
  maxIngestBytes: 262_144_000, minFreeBytes: 1024, stagedSweepAgeMs: 3_600_000,
  roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0,
  ...over,
} as any);

const litersCfg = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  sinkToken: "sink-token-internal-0123456789",
  sinkAddr: "127.0.0.1:9736",
  binPath: path.join(dataDir, "no-such-binary"),
  bucketDir: path.join(dataDir, "ltx-bucket"),
  statusPath: path.join(dataDir, "liters-sink-status.json"),
  maxPushBytes: 1_048_576, staleStatusSeconds: 120,
  ...over,
});

let prevEnabled: string | undefined;

beforeEach(() => {
  prevEnabled = process.env.LITERS_SINK_ENABLED;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  if (prevEnabled === undefined) delete process.env.LITERS_SINK_ENABLED;
  else process.env.LITERS_SINK_ENABLED = prevEnabled;
});

/** GET /healthz against a real listener, since the handler is only reachable through the router. */
async function healthz(app: ReturnType<typeof createApp>): Promise<any> {
  const server = app.listen(0);
  const port = (server.address() as any).port;
  try {
    const body = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
        let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d));
      }).on("error", reject);
    });
    return JSON.parse(body);
  } finally {
    server.close();
  }
}

describe("liters deploy guard — the operator said ON and the build cannot serve it", () => {
  it("refuses to boot when LITERS_SINK_ENABLED=1 but the build has no liters config", () => {
    process.env.LITERS_SINK_ENABLED = "1";
    // A Config with NO `liters` key: exactly what `loadConfig` on the v37 tree produced.
    expect(() => createApp(baseCfg())).toThrow(/LITERS_SINK_ENABLED=1 but this build has no liters configuration/);
  });

  it("names the fix in the error, since the machine cannot be repaired into working", () => {
    process.env.LITERS_SINK_ENABLED = "1";
    expect(() => createApp(baseCfg())).toThrow(/deploy a build that includes the liters receive path, or unset LITERS_SINK_ENABLED/);
  });

  it("boots normally when the env var is unset and there is no liters config — every server before this feature", () => {
    delete process.env.LITERS_SINK_ENABLED;
    expect(() => createApp(baseCfg())).not.toThrow();
  });

  it("boots when the env var is set AND the build has liters support — the intended deployment", () => {
    process.env.LITERS_SINK_ENABLED = "1";
    expect(() => createApp(baseCfg({ liters: litersCfg() }))).not.toThrow();
  });

  it("does not fire on a value other than 1, matching how loadConfig reads it", () => {
    process.env.LITERS_SINK_ENABLED = "0";
    expect(() => createApp(baseCfg())).not.toThrow();
  });
});

describe("liters deploy guard — /healthz stops answering ok through a dead replication path", () => {
  it("reports degraded when liters is on but the sidecar never started", async () => {
    delete process.env.LITERS_SINK_ENABLED;   // the throw above is not what is under test here
    const body = await healthz(createApp(baseCfg({ liters: litersCfg() })));
    expect(body.ok).toBe(true);               // still 200/ok — a degraded machine stays deployable
    expect(body.degraded).toBe(true);
    expect(body.warnings.join(" ")).toMatch(/liters enabled but the sidecar did not start/);
    expect(body.warnings.join(" ")).toMatch(/page replication is DOWN/);
  });

  it("stays exactly {ok:true} when liters is switched off — no new noise for a default server", async () => {
    delete process.env.LITERS_SINK_ENABLED;
    const body = await healthz(createApp(baseCfg({ liters: litersCfg({ enabled: false }) })));
    expect(body).toEqual({ ok: true });
  });

  it("stays exactly {ok:true} on a config with no liters section at all", async () => {
    delete process.env.LITERS_SINK_ENABLED;
    const body = await healthz(createApp(baseCfg()));
    expect(body).toEqual({ ok: true });
  });
});

// Caught live, minutes after the restore deploy: /healthz reported "the apply loop is wedged" against
// a sink that had been running happily for two minutes. `stalled` was derived from `lastSyncAtMs`
// INSIDE the status file, which only moves when a push is actually applied — so a healthy sink with an
// empty queue looked wedged the moment it passed staleStatusSeconds. The sink rewrites the file every
// round regardless, so the file's mtime is the liveness signal, and config.ts had documented it that
// way all along ("seconds without a status-file update").
describe("liters stalled — file mtime, not lastSyncAtMs", () => {
  /** A sink binary that exists, so startLitersSink returns a real handle rather than null. */
  const realBin = () => {
    const p = path.join(dataDir, "fake-sink");
    fs.writeFileSync(p, "#!/bin/sh\nsleep 300\n", { mode: 0o755 });
    return p;
  };

  const writeStatus = (statusPath: string, mtimeMs: number) => {
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    // lastSyncAtMs: 0 — the idle case. A sink that has never had a push to apply.
    fs.writeFileSync(statusPath, JSON.stringify({
      ok: true, position: 4, bucketMax: 4, lastSyncAtMs: 0, lastError: null, lockBusy: false,
      applies: 0, lockBusyTotal: 0, errorsTotal: 0, freeBytes: 1e10, bucketBytes: 1, mirrorBytes: 1,
      spaceOk: true, sweptTotal: 0, startedAtMs: Date.now() - 3_600_000, minFreeBytes: 1,
    }));
    fs.utimesSync(statusPath, new Date(mtimeMs), new Date(mtimeMs));
  };

  it("an idle sink whose status file is FRESH is not stalled, even with lastSyncAtMs 0", async () => {
    delete process.env.LITERS_SINK_ENABLED;
    const statusPath = path.join(dataDir, "liters-sink-status.json");
    writeStatus(statusPath, Date.now());   // written just now; never synced
    const app = createApp(baseCfg({ liters: litersCfg({ binPath: realBin(), statusPath }) }));
    const body = await healthz(app);
    expect(body).toEqual({ ok: true });    // NOT degraded — this is the false positive
  });

  it("a status file that has stopped being rewritten IS stalled", async () => {
    delete process.env.LITERS_SINK_ENABLED;
    const statusPath = path.join(dataDir, "liters-sink-status.json");
    writeStatus(statusPath, Date.now() - 600_000);   // 10 minutes cold, staleStatusSeconds is 120
    const app = createApp(baseCfg({ liters: litersCfg({ binPath: realBin(), statusPath }) }));
    const body = await healthz(app);
    expect(body.degraded).toBe(true);
    expect(body.warnings.join(" ")).toMatch(/status file has not moved/);
  });
});
