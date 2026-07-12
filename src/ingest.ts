import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import Database from "better-sqlite3"; import AdmZip from "adm-zip";
import type { Config } from "./config.js";
import { openServerDb } from "./serverdb.js";

export { openServerDb } from "./serverdb.js";
export class IngestError extends Error { constructor(public code: string, msg?: string) { super(msg ?? code); } }
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");

export function latestIngest(cfg: Pick<Config, "serverDbPath">) {
  const db = openServerDb(cfg);
  const r = db.prepare("SELECT receivedAt, bytes, latestDay FROM ingestLog ORDER BY id DESC LIMIT 1").get() as any;
  db.close();
  return r ?? null;
}

export function ingestNoopbak(buf: Buffer, cfg: Pick<Config, "dataDir" | "mirrorPath" | "serverDbPath" | "maxIngestBytes">): { ok: true; bytes: number; latestDay: string | null } {
  if (buf.length > cfg.maxIngestBytes) throw new IngestError("too_large", `body ${buf.length} > ${cfg.maxIngestBytes}`);
  let zip: AdmZip;
  try { zip = new AdmZip(buf); } catch { throw new IngestError("bad_zip"); }
  const entry = zip.getEntries().find((e) => e.entryName.endsWith(".sqlite"));
  if (!entry) throw new IngestError("no_sqlite_entry");
  if (entry.header.size > cfg.maxIngestBytes) throw new IngestError("too_large", `decompressed entry ${entry.header.size} > ${cfg.maxIngestBytes}`);
  const sqliteBytes = entry.getData();
  // entry.header.size comes from the (attacker-controlled) central directory header and can be
  // forged — including forged to 0 — which would skip the earlier header-size check entirely and
  // bypass adm-zip's own maxOutputLength bounding. Re-check the ACTUAL decompressed size here.
  if (sqliteBytes.length === 0 || sqliteBytes.length > cfg.maxIngestBytes) {
    throw new IngestError("too_large", `decompressed entry ${sqliteBytes.length} bytes`);
  }
  if (!sqliteBytes.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) throw new IngestError("bad_magic");

  // Stage to a temp file, validate, then atomically rename into place.
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const staged = path.join(cfg.dataDir, `.staged-${crypto.randomBytes(6).toString("hex")}.sqlite`);
  fs.writeFileSync(staged, sqliteBytes);
  try {
    const sdb = new Database(staged, { readonly: true });
    try {
      const qc = sdb.pragma("quick_check", { simple: true });
      if (qc !== "ok") throw new IngestError("quick_check_failed", String(qc));
      const hasGrdb = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='grdb_migrations'").get();
      if (!hasGrdb) throw new IngestError("foreign_db");
      var latestDay = (sdb.prepare("SELECT MAX(day) d FROM dailyMetric").get() as any)?.d ?? null;
    } finally { sdb.close(); }
    // Atomic swap: rename staged -> mirror (same filesystem). Remove stale WAL/SHM sidecars.
    for (const ext of ["-wal", "-shm"]) { const s = cfg.mirrorPath + ext; if (fs.existsSync(s)) fs.rmSync(s); }
    fs.renameSync(staged, cfg.mirrorPath);
  } catch (e) {
    if (fs.existsSync(staged)) fs.rmSync(staged);
    throw e;
  }
  const db = openServerDb(cfg);
  db.prepare("INSERT INTO ingestLog (receivedAt, bytes, latestDay) VALUES (?,?,?)").run(Math.floor(Date.now() / 1000), buf.length, latestDay);
  db.close();
  return { ok: true, bytes: buf.length, latestDay };
}
