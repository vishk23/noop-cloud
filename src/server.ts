import express from "express";
import fs from "node:fs";
import { Config, loadConfig } from "./config.js";

export function createApp(cfg: Config): express.Express {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const app = express();
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  return app;
}

// Entry point (ignored by tests, which import createApp directly).
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const cfg = loadConfig();
  createApp(cfg).listen(cfg.port, () => console.log(`noop-cloud on :${cfg.port}`));
}
