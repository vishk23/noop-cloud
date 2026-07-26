import express from "express";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Config, loadConfig } from "./config.js";
import { requireScope, tokenScope, safeEqual } from "./auth.js";
import { ingestNoopbak, IngestError, normalizePhoneTz } from "./ingest.js";
import { buildMcpServer } from "./mcp.js";
import { journalSince, ackEdits } from "./staging.js";
import { upsertDeviceToken } from "./push/registry.js";
import { ingestDeepBufferChunk, DeepBufError, parseChunkHeaders } from "./deepbuf.js";
import { makeObjectStore } from "./objectstore.js";
import { storageReport, sweepStagedArtifacts } from "./storage.js";

const DEVICE_TOKEN_RE = /^[0-9a-fA-F]{32,100}$/;

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
  app.get("/status", requireScope(cfg, "ro"), (_req, res) => {
    try {
      res.json(storageReport(cfg));
    } catch (e) {
      res.status(500).json({ ok: false, error: "status_failed", detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/ingest", requireScope(cfg, "rw"),
    express.raw({ type: "*/*", limit: cfg.maxIngestBytes }),
    (req, res) => {
      try {
        const phoneTz = normalizePhoneTz(req.header("x-phone-timezone"));
        const out = ingestNoopbak(req.body as Buffer, cfg, phoneTz);
        res.json(out);
      } catch (e) {
        // e.status, not a flat 400: `insufficient_space`/`storage_unavailable` are 507s so the phone
        // reads them as "server has no room, keep the backup and retry later" rather than "this
        // upload is malformed, discard it". `detail` carries the actual byte numbers.
        if (e instanceof IngestError) {
          if (e.status >= 500) console.error("ingest storage error", e.code, e.message);
          return res.status(e.status).json({ error: e.code, ...(e.status >= 500 ? { detail: e.message } : {}) });
        }
        console.error("ingest error", e);
        res.status(500).json({ error: "ingest_failed" });
      }
    });

  // One line-aligned, raw-DEFLATE byte range of the phone's append-only deep-buffer log (#423).
  // Its own body limit, NOT cfg.maxIngestBytes (which is 768 MB for the whole-DB /ingest) — a chunk is
  // bounded at ~24 MB compressed and there is no reason to let this path allocate three orders of
  // magnitude more than it can legitimately need.
  app.post("/deepbuf", requireScope(cfg, "rw"),
    express.raw({ type: "*/*", limit: cfg.maxDeepbufBytes }),
    async (req, res) => {
      // 503, never a Fly-volume fallback: ~600 MB/day of archive against ~547 MB free would take the
      // whole server down with it (see src/objectstore.ts). Refusing loudly is the safe failure.
      if (!objectStore) return res.status(503).json({ error: "storage_not_configured" });
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
