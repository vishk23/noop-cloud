import express from "express";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Config, loadConfig } from "./config.js";
import { requireScope, tokenScope, safeEqual } from "./auth.js";
import { ingestNoopbakFile, receiveUploadBody, requireSpaceFor, stagedPath, IngestError, UploadAbortedError, normalizePhoneTz } from "./ingest.js";
import { buildMcpServer } from "./mcp.js";
import { journalSince, ackEdits } from "./staging.js";
import { upsertDeviceToken } from "./push/registry.js";
import { ingestDeepBufferChunk, DeepBufError, parseChunkHeaders } from "./deepbuf.js";
import { makeObjectStore } from "./objectstore.js";
import { storageReport, sweepStagedArtifacts, isVolumeError, storageFailureMessage } from "./storage.js";
import { litersProxy, litersDisabled } from "./liters/proxy.js";
import { startLitersSink, type SinkHandle } from "./liters/sink.js";
import { readStatus as readLitersStatus, statusAgeSeconds as litersStatusAge } from "./liters/state.js";

const DEVICE_TOKEN_RE = /^[0-9a-fA-F]{32,100}$/;

/**
 * Answer once, or not at all.
 *
 * /ingest streams for minutes, so by the time an error surfaces the socket may already be gone or
 * already answered. Writing to it then throws INSIDE the catch block — an unhandled rejection out of
 * an async Express handler, which takes the whole process down. That is a strictly worse outcome
 * than the failure being reported.
 */
function reply(res: express.Response, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  try { res.status(status).json(body); } catch (e) { console.error("failed to send response", e); }
}

export function createApp(cfg: Config): express.Express {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const app = express();
  // Built once, not per request: the S3 client pools connections, and the phone drains up to 8 chunks
  // back-to-back in a single background wake. null = bulk storage unconfigured (see makeObjectStore).
  const objectStore = makeObjectStore(cfg);

  // Reclaim staged corpses left by a crash/OOM/SIGKILL during a previous boot's ingest. Nothing is in
  // flight at construction time, but sweepStagedArtifacts keeps its age guard anyway and swallows its
  // own errors — startup must never be blocked by cleanup.
  try {
    const swept = sweepStagedArtifacts(cfg.dataDir, { olderThanMs: cfg.stagedSweepAgeMs });
    if (swept.removed) console.log(`swept ${swept.removed} orphaned staging artifact(s), reclaimed ${swept.bytes} bytes`);
  } catch { /* best-effort */ }

  // The operator said ON, and this BUILD cannot serve it. Not a degraded runtime — the wrong
  // artifact is deployed, and no amount of retrying fixes it.
  //
  // This is the 2026-07-28 failure, exactly. Release v37 was built from `main`, which carried no
  // liters code at all (the receive path lived only on `feat/liters-receive` and was never merged),
  // while the `LITERS_SINK_ENABLED` secret stayed set and marked Deployed. Config said on, code was
  // gone, and every route under /liters answered 404 — including the `PUT /liters/ltx/0/...` the
  // phone actually calls. 51 hours, zero pushes, and nothing anywhere said so: a 404 is
  // indistinguishable from a 503 to the phone's fallback, so /ingest silently carried three full
  // uploads instead.
  //
  // Refusing to boot is the right response ONLY for this case, and it is a deliberate exception to
  // the rule one line below (a missing BINARY must not be fatal — /ingest is the fallback and a
  // cloud that will not boot is worse than one missing an optional path). The difference: a missing
  // binary is a machine that can still be fixed by fixing the machine, whereas a build with no
  // liters support cannot serve /liters no matter what any operator does to it, so booting it only
  // buys a silent outage. Fly holds the previous release when a new one will not start, which is the
  // outcome you want here.
  //
  // Keyed on the raw env var and living in server.ts — NOT in src/liters/ — on purpose: the check has
  // to survive in a build that has no liters module, which is precisely the build it exists to catch.
  // Note the honest limit: no in-repo assertion can guard a build that does not contain the
  // assertion. Deploying a tree that predates this line reproduces v37 exactly. The durable guard is
  // the post-deploy probe in docs/LITERS_RECEIVE.md — a `PUT /liters/ltx/0/...` that answers 404 is
  // absent code; 503 is code present and switched off.
  if (process.env.LITERS_SINK_ENABLED === "1" && !cfg.liters) {
    throw new Error(
      "LITERS_SINK_ENABLED=1 but this build has no liters configuration — it cannot serve /liters " +
      "(every path would 404, and the phone would silently fall back to /ingest). This is a build/" +
      "config mismatch, not a runtime failure: deploy a build that includes the liters receive path, " +
      "or unset LITERS_SINK_ENABLED.",
    );
  }

  // The receive-side sidecar. `null` when LITERS_SINK_ENABLED is unset (the default) or the binary
  // is absent — in both cases the server runs exactly as it did before, and /liters answers a
  // legible 503. Nothing about /ingest changes either way.
  const sink: SinkHandle | null = startLitersSink(cfg);
  if (sink) {
    const shutdown = () => sink.stop();
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    process.once("exit", shutdown);
  }

  /**
   * What the sidecar says about itself, for `GET /status`.
   *
   * `stalled` is the number worth reading: the sink republishes its status after EVERY round
   * (default 1s), so a status file that has stopped moving means the apply loop is wedged or the
   * process is gone — which is a different failure from "replication is behind", and the two would
   * otherwise be indistinguishable from the outside.
   */
  const litersReport = () => {
    if (!cfg.liters?.enabled) return { enabled: false as const };
    const st = readLitersStatus(cfg);
    // Age of the status FILE (mtime), not of any field inside it. The sink rewrites the file every
    // round whether or not the round had work; `lastSyncAtMs` only moves when a push is actually
    // applied and sits at 0 forever on a healthy sink with an empty queue. Deriving `stalled` from
    // the field reported "the apply loop is wedged" for a freshly-restored, perfectly-idle sink two
    // minutes after boot. config.ts has always documented this as "seconds without a status-file
    // update"; this makes the code agree with it. See statusAgeSeconds in src/liters/state.ts.
    const ageSeconds = litersStatusAge(cfg);
    return {
      enabled: true as const,
      running: sink?.running() ?? false,
      restarts: sink?.restarts() ?? 0,
      lastExit: sink?.lastExit() ?? null,
      status: st,
      behind: st ? Math.max(0, st.bucketMax - st.position) : null,
      statusAgeSeconds: ageSeconds,
      // Never stalled when the sink has not published at all yet: that is "starting", and it is
      // already covered by `running`. Only a file that once moved and then stopped is a wedge.
      stalled: st !== null && ageSeconds !== null && ageSeconds > cfg.liters.staleStatusSeconds,
    };
  };

  /**
   * One line for /healthz when liters is switched ON but is not actually replicating, else `null`.
   *
   * Three distinct ways to be enabled-and-not-serving, and they need different fixes, so they are
   * reported separately rather than as one "liters unhealthy":
   *
   *   - the sidecar never started (binary absent — the image was built without the Rust stage);
   *   - it started and is gone or crash-looping (`running() === false`, `restarts` climbing);
   *   - it is alive but its status file has stopped moving, i.e. the apply loop is wedged.
   *
   * Deliberately NOT reported: `behind > 0`. Being behind is what replication looks like while it
   * works. Only "has stopped" is a health problem.
   *
   * This does not throw and does not read the mirror — /healthz answers on a schedule Fly enforces.
   */
  const litersDegradation = (): string | null => {
    if (!cfg.liters?.enabled) return null;
    if (!sink) {
      return `liters enabled but the sidecar did not start (${cfg.liters.binPath} missing) — ` +
             `page replication is DOWN and every push is falling back to /ingest`;
    }
    const r = litersReport();
    if (r.enabled !== true) return null;
    if (!r.running) {
      return `liters enabled but the sidecar is not running (restarts=${r.restarts}, ` +
             `lastExit=${JSON.stringify(r.lastExit)}) — page replication is DOWN`;
    }
    if (r.stalled) {
      return `liters sidecar is running but its status file has not moved in more than ` +
             `${cfg.liters.staleStatusSeconds}s — the apply loop is wedged, not merely behind`;
    }
    return null;
  };

  // Liveness, plus an honest verdict on whether this process can actually SERVE — but deliberately
  // still 200 when it cannot.
  //
  // Fly's [[http_service.checks]] points here, so a non-2xx pulls the machine out of routing and
  // fails deploys. During the 2026-07-26 full-volume outage that would have turned "every tool
  // returns a clear storage error" into "the host is unreachable" — strictly worse to debug, and it
  // would have blocked deploying the very fix. So the verdict rides along as a `degraded` flag
  // (absent when healthy, which keeps the response exactly `{ok:true}`), and /status carries detail.
  //
  // probeMirror is what makes this a serving check rather than a process-alive check. Without it a
  // mirror corrupted in place reads as perfectly healthy here — disk fine, no orphans, server.sqlite
  // fine — while every mirror-backed MCP tool returns "storage is degraded". That is the same
  // green-through-an-outage signature as 2026-07-26, which is the reason to close it.
  app.get("/healthz", (_req, res) => {
    let degraded: string[] | null = null;
    try {
      const s = storageReport(cfg, { probeMirror: true });
      if (!s.ok) degraded = s.warnings;
    } catch { /* a health probe must not throw */ }
    // liters rides the same flag, for the reason /healthz probes the mirror at all: "the process is
    // up" is not the property anyone cares about. Between 2026-07-28 and 2026-07-30 the machine was
    // enabled-and-not-serving for 51 hours and every signal available said fine — /healthz `{ok:true}`,
    // the Fly check passing, `errorsTotal: 0` (the sink was not running, so it never observed a
    // failing push), and /ingest quietly absorbing three full uploads because the phone treats a 404
    // exactly like a 503. `curl /healthz` is the check that costs seconds; this makes it say something.
    try {
      const w = litersDegradation();
      if (w) degraded = [...(degraded ?? []), w];
    } catch { /* a health probe must not throw */ }
    res.json(degraded ? { ok: true, degraded: true, warnings: degraded } : { ok: true });
  });

  // Full storage/ingest diagnostics: disk free %, mirror size, orphaned staging bytes, and how long
  // since the last successful ingest — the numbers that would have made the outage visible days
  // early. Behind `ro` because it reports host paths and volume geometry.
  //
  // The only caller that asks for `pageChurn` — the P0 page-diff measurements of
  // docs/SYNC_BUILD_VS_BUY.md. /healthz and the `data_freshness` MCP tool share this report and
  // deliberately do not carry the experiment's log.
  app.get("/status", requireScope(cfg, "ro"), (_req, res) => {
    try {
      res.json({ ...storageReport(cfg, { pageChurnLimit: 20, probeMirror: true }), liters: litersReport() });
    } catch (e) {
      res.status(500).json({ ok: false, error: "status_failed", detail: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- liters page replication (docs/LITERS_RECEIVE.md) ------------------------------------
  //
  // Registered BEFORE any body parser and with no `express.json`/`express.raw` anywhere near it: an
  // LTX push is a stream, and buffering it is the mistake `/ingest` already paid for once (the
  // 200-400 MB `express.raw` that OOM-killed the machine on 2026-07-26).
  //
  // `app.use` rather than `app.all` so Express strips the `/liters` prefix from `req.url` — the sink
  // runs `base_path: None` and expects to see the endpoint grammar at its root.
  app.use("/liters", cfg.liters?.enabled ? litersProxy(cfg) : litersDisabled(cfg));

  // NO express.raw. The whole-DB body is 200-400 MB compressed and buffering it was the first of the
  // three full copies that OOM-killed the machine on 2026-07-26 (see src/zipstream.ts). The body is
  // streamed to a `.staged-*.noopbak` on the volume and inflated from there, so this handler's
  // memory is flat in the size of the database.
  app.post("/ingest", requireScope(cfg, "rw"), async (req, res) => {
    // Cheapest rejection there is: the phone declares the size before sending a byte of it.
    const declared = Number(req.header("content-length"));
    if (Number.isFinite(declared) && declared > cfg.maxIngestBytes) {
      return res.status(413).json({ error: "too_large" });
    }
    const upload = stagedPath(cfg.dataDir, "noopbak");
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      // Refuse before accepting the transfer when the volume cannot even hold the compressed body.
      // Accepting 300 MB we have nowhere to put is how the volume filled in the first place.
      if (Number.isFinite(declared) && declared > 0) requireSpaceFor(declared, cfg, "upload body");
      await receiveUploadBody(req, upload, cfg);
      const phoneTz = normalizePhoneTz(req.header("x-phone-timezone"));
      // Collected, not awaited: the page-churn walk is ~54 s on the real mirror pair and the phone
      // times out after 60 s of inactivity, so it must not sit between the swap and this response.
      const churnTasks: Array<() => Promise<void>> = [];
      const out = await ingestNoopbakFile(upload, cfg, phoneTz, {
        consume: true, deferChurn: (t) => churnTasks.push(t),
      });
      res.json(out);
      // AFTER the response, deliberately. The walk yields the event loop every 64 MiB, so /healthz —
      // Fly's 5 s service check — keeps answering while it runs. Telemetry never escalates: a throw
      // here would be an unhandled rejection on a request that already succeeded.
      for (const task of churnTasks) {
        void task().catch((e) => console.warn("deferred page-churn telemetry failed:", e));
      }
    } catch (e) {
      // The phone hung up mid-upload (backgrounded, lost signal). There is no socket to answer on
      // and nothing was corrupted — the staged body is removed below like any other failure.
      if (e instanceof UploadAbortedError) {
        console.warn("ingest aborted by client after", e.bytesReceived, "bytes");
        return;
      }
      // e.status, not a flat 400: `insufficient_space`/`storage_unavailable` are 507s so the phone
      // reads them as "server has no room, keep the backup and retry later" rather than "this
      // upload is malformed, discard it". `detail` carries the actual byte numbers.
      if (e instanceof IngestError) {
        if (e.status >= 500) console.error("ingest storage error", e.code, e.message);
        return reply(res, e.status, { error: e.code, ...(e.status >= 500 ? { detail: e.message } : {}) });
      }
      // A volume fault outside ingestNoopbakFile's own try (the body write itself) still has to read
      // as "server has no room", not as a malformed upload.
      if (isVolumeError(e)) {
        console.error("ingest body write failed", e);
        return reply(res, 507, { error: "storage_unavailable", detail: storageFailureMessage(cfg, e) });
      }
      console.error("ingest error", e);
      reply(res, 500, { error: "ingest_failed" });
    } finally {
      // Belt and braces: ingestNoopbakFile consumes the body itself, but every path that throws
      // before it runs — and every path inside it — must leave nothing behind. A leaked 300 MB
      // staged file is how the volume reached 0 bytes free.
      fs.rmSync(upload, { force: true });
    }
  });

  // One line-aligned, raw-DEFLATE byte range of the phone's append-only deep-buffer log (#423).
  // Its own body limit, NOT cfg.maxIngestBytes (1 GiB, for the whole-DB /ingest) — a chunk is
  // bounded at ~24 MB compressed and there is no reason to let this path allocate three orders of
  // magnitude more than it can legitimately need.
  app.post("/deepbuf", requireScope(cfg, "rw"),
    express.raw({ type: "*/*", limit: cfg.maxDeepbufBytes }),
    async (req, res) => {
      // 503, never a Fly-volume fallback: ~600 MB/day of archive against ~547 MB free would take the
      // whole server down with it (see src/objectstore.ts). Refusing loudly is the safe failure.
      //
      // The body says WHICH KIND of "no" this is. The phone renders a non-2xx as the raw body prefix
      // ("The cloud sync server returned an error (503) — …"), so a bare error code made a deliberately
      // unconfigured OPTIONAL feature look identical to the whole-DB upload being broken — and the two
      // appeared side by side during the 2026-07-26 outage, which is how one real failure read as two.
      // `configured:false` mirrors what the deep_buffer_* MCP tools already answer.
      if (!objectStore) {
        return res.status(503).json({
          error: "storage_not_configured",
          configured: false,
          feature: "deepbuf",
          detail: "Deep-buffer bulk upload is switched off on this server: no object-storage bucket is configured. " +
            "This is an optional feature that has never been enabled, not a failure — the whole-database POST /ingest " +
            "backup is unaffected, and no data was lost. Nothing on the phone needs fixing; retrying will keep " +
            "returning this until a bucket is configured server-side.",
        });
      }
      try {
        const headers = parseChunkHeaders({
          generation: req.header("x-deepbuf-generation"),
          byteStart: req.header("x-deepbuf-byte-start"),
          byteEnd: req.header("x-deepbuf-byte-end"),
          compression: req.header("x-deepbuf-compression"),
        });
        const out = await ingestDeepBufferChunk(req.body as Buffer, headers, cfg, objectStore, {
          deviceId: req.header("x-deepbuf-device") ?? null,
          phoneTz: normalizePhoneTz(req.header("x-phone-timezone")),
        });
        res.json(out);
      } catch (e) {
        if (e instanceof DeepBufError) return res.status(400).json({ error: e.code });
        console.error("deepbuf error", e);
        res.status(500).json({ error: "deepbuf_failed" });
      }
    });

  app.post("/register-device", requireScope(cfg, "rw"), express.json({ limit: "16kb" }), (req, res) => {
    const token = (req.body as any)?.token;
    const platform = (req.body as any)?.platform;
    if (typeof token !== "string" || !DEVICE_TOKEN_RE.test(token)) return res.status(400).json({ error: "bad_token" });
    if (platform !== "ios") return res.status(400).json({ error: "bad_platform" });
    const count = upsertDeviceToken(cfg, token, platform);
    res.json({ registered: true, count });
  });

  const runMcp = async (scope: "public" | "ro" | "rw", req: express.Request, res: express.Response) => {
    const server = buildMcpServer(cfg, scope);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("mcp error", e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  };

  app.post("/mcp", requireScope(cfg, "ro"), express.json({ limit: "4mb" }), async (req, res) => {
    const scope = tokenScope(cfg, req.header("authorization")) ?? "ro"; // requireScope already vetted it
    await runMcp(scope, req, res);
  });

  // No-auth entry point for clients that cannot send an Authorization header (ChatGPT's "No Auth"
  // connector). The path segment IS the credential; a miss is a 404 so the route never advertises
  // itself. Serves the strict "public" scope — pure reads only, never the write-proposal or push
  // tools. Disabled (404) unless MCP_URL_SECRET is configured. app.all so a wrong secret 404s on any
  // method and a right secret + non-POST 405s (like the bearer /mcp route), rather than falling
  // through to a bare Express 404 that a probing connector could misread as a wrong URL.
  app.all("/mcp/:secret", express.json({ limit: "4mb" }), async (req, res) => {
    if (!cfg.mcpUrlSecret || !safeEqual(req.params.secret, cfg.mcpUrlSecret)) {
      return res.status(404).json({ error: "not_found" });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    await runMcp("public", req, res);
  });
  app.all("/mcp", (_req, res) => res.status(405).json({ error: "method_not_allowed" }));

  app.get("/edits", requireScope(cfg, "ro"), (req, res) => {
    const raw = req.query.since;
    const since = raw === undefined ? 0 : Number(raw);
    if (!Number.isInteger(since) || since < 0) return res.status(400).json({ error: "bad_since" });
    const edits = journalSince(cfg, since);
    res.json({ edits, latestSeq: edits.length ? edits[edits.length - 1].seq : since });
  });

  app.post("/edits/ack", requireScope(cfg, "rw"), express.json({ limit: "64kb" }), (req, res) => {
    const seqs = (req.body as any)?.seqs;
    if (!Array.isArray(seqs) || seqs.length === 0 || seqs.length > 500 || !seqs.every((s) => Number.isInteger(s) && s > 0)) {
      return res.status(400).json({ error: "bad_seqs" });
    }
    res.json({ acked: ackEdits(cfg, seqs) });
  });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "too_large" });
    console.error("unhandled request error", err?.message ?? err);
    res.status(500).json({ error: "internal" });
  });

  return app;
}

// Entry point (ignored by tests, which import createApp directly).
// process.argv[1].endsWith("server.js") alone never matches under `tsx` (dev runs server.ts),
// so this also checks the resolved module URL and a ".ts" suffix.
const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith("/server.js") || process.argv[1].endsWith("/server.ts"));
if (isMain) {
  const cfg = loadConfig();
  createApp(cfg).listen(cfg.port, () => console.log(`noop-cloud on :${cfg.port}`));
}
