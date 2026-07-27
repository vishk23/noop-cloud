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

  // Liveness ONLY, and deliberately still 200 when storage is degraded.
  //
  // Fly's [[http_service.checks]] points here, so a non-2xx pulls the machine out of routing and
  // fails deploys. During the 2026-07-26 full-volume outage that would have turned "every tool
  // returns a clear storage error" into "the host is unreachable" — strictly worse to debug, and it
  // would have blocked deploying the very fix. So the disk verdict rides along as a `degraded` flag
  // (absent when healthy, which keeps the response exactly `{ok:true}`), and /status carries detail.
  app.get("/healthz", (_req, res) => {
    let degraded: string[] | null = null;
    try {
      const s = storageReport(cfg);
      if (!s.ok) degraded = s.warnings;
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
      res.json(storageReport(cfg, { pageChurnLimit: 20 }));
    } catch (e) {
      res.status(500).json({ ok: false, error: "status_failed", detail: e instanceof Error ? e.message : String(e) });
    }
  });

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
      const out = await ingestNoopbakFile(upload, cfg, phoneTz, { consume: true });
      res.json(out);
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
