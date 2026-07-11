import express from "express";
import fs from "node:fs";
import { Config, loadConfig } from "./config.js";
import { requireScope } from "./auth.js";
import { ingestNoopbak, IngestError } from "./ingest.js";

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

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "too_large" });
    console.error("unhandled request error", err?.message ?? err);
    res.status(500).json({ error: "internal" });
  });

  return app;
}

// Entry point (ignored by tests, which import createApp directly).
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const cfg = loadConfig();
  createApp(cfg).listen(cfg.port, () => console.log(`noop-cloud on :${cfg.port}`));
}
