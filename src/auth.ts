import crypto from "node:crypto";
import type { RequestHandler } from "express";
import type { Config } from "./config.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function requireScope(cfg: Config, scope: "ro" | "rw"): RequestHandler {
  return (req, res, next) => {
    const h = req.header("authorization") ?? "";
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) return res.status(401).json({ error: "unauthorized" });
    const token = m[1];
    const isRw = safeEqual(token, cfg.rwToken);
    const isRo = safeEqual(token, cfg.roToken);
    const ok = scope === "rw" ? isRw : isRo || isRw;
    if (!ok) return res.status(401).json({ error: "unauthorized" });
    next();
  };
}
