import express from "express";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Config, loadConfig } from "./config.js";
import { requireScope, tokenScope } from "./auth.js";
import { ingestNoopbak, IngestError } from "./ingest.js";
import { buildMcpServer } from "./mcp.js";

export function createApp(cfg: Config): express.Express {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const app = express();
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.post("/ingest", requireScope(cfg, "rw"),
    express.raw({ type: "*/*", limit: cfg.maxIngestBytes }),
    (req, res) => {
      try {
        const out = ingestNoopbak(req.body as Buffer, cfg);
        res.json(out);
      } catch (e) {
        if (e instanceof IngestError) return res.status(400).json({ error: e.code });
        console.error("ingest error", e);
        res.status(500).json({ error: "ingest_failed" });
      }
    });

  app.post("/mcp", requireScope(cfg, "ro"), express.json({ limit: "4mb" }), async (req, res) => {
    const scope = tokenScope(cfg, req.header("authorization")) ?? "ro"; // requireScope already vetted it
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
  });
  app.all("/mcp", (_req, res) => res.status(405).json({ error: "method_not_allowed" }));

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
