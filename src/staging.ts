import type { Config } from "./config.js";
import { openServerDb } from "./serverdb.js";

type C = Pick<Config, "serverDbPath">;

export interface ProposalRow {
  id: string; kind: string; payloadJSON: string; rationale: string;
  beforeJSON: string | null; diffText: string;
  status: "pending" | "confirmed" | "rejected"; createdAt: number; resolvedAt: number | null;
}
export interface JournalRow {
  seq: number; editId: string; kind: string; payloadJSON: string;
  beforeJSON: string | null; rationale: string | null; appliedAt: number; undoneBySeq: number | null;
}

function withDb<T>(cfg: C, fn: (db: ReturnType<typeof openServerDb>) => T): T {
  const db = openServerDb(cfg);
  try { return fn(db); } finally { db.close(); }
}

export function createProposal(cfg: C, p: Omit<ProposalRow, "status" | "createdAt" | "resolvedAt">): ProposalRow {
  return withDb(cfg, (db) => {
    const createdAt = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO proposal (id, kind, payloadJSON, rationale, beforeJSON, diffText, status, createdAt)
                VALUES (?,?,?,?,?,?, 'pending', ?)`)
      .run(p.id, p.kind, p.payloadJSON, p.rationale, p.beforeJSON, p.diffText, createdAt);
    return { ...p, status: "pending", createdAt, resolvedAt: null };
  });
}
export function getProposal(cfg: C, id: string): ProposalRow | null {
  return withDb(cfg, (db) => (db.prepare("SELECT * FROM proposal WHERE id = ?").get(id) as ProposalRow | undefined) ?? null);
}
export function listPending(cfg: C): ProposalRow[] {
  return withDb(cfg, (db) => db.prepare("SELECT * FROM proposal WHERE status = 'pending' ORDER BY createdAt, id").all() as ProposalRow[]);
}
export function resolveProposal(cfg: C, id: string, status: "confirmed" | "rejected"): ProposalRow | null {
  return withDb(cfg, (db) => {
    const r = db.prepare("UPDATE proposal SET status = ?, resolvedAt = ? WHERE id = ? AND status = 'pending'")
      .run(status, Math.floor(Date.now() / 1000), id);
    if (r.changes === 0) return null;
    return db.prepare("SELECT * FROM proposal WHERE id = ?").get(id) as ProposalRow;
  });
}
export function appendJournal(cfg: C, e: { editId: string; kind: string; payloadJSON: string; beforeJSON: string | null; rationale: string | null }): number {
  return withDb(cfg, (db) => {
    const r = db.prepare(`INSERT INTO editJournal (editId, kind, payloadJSON, beforeJSON, rationale, appliedAt)
                          VALUES (?,?,?,?,?,?)`)
      .run(e.editId, e.kind, e.payloadJSON, e.beforeJSON, e.rationale, Math.floor(Date.now() / 1000));
    return Number(r.lastInsertRowid);
  });
}
export function journalSince(cfg: C, since: number): JournalRow[] {
  return withDb(cfg, (db) => db.prepare("SELECT * FROM editJournal WHERE seq > ? ORDER BY seq").all(since) as JournalRow[]);
}
export function activeEdits(cfg: C): JournalRow[] {
  return withDb(cfg, (db) => db.prepare("SELECT * FROM editJournal WHERE undoneBySeq IS NULL AND kind != 'undo' ORDER BY seq").all() as JournalRow[]);
}
export function markUndone(cfg: C, targetSeq: number, bySeq: number): void {
  withDb(cfg, (db) => db.prepare("UPDATE editJournal SET undoneBySeq = ? WHERE seq = ? AND undoneBySeq IS NULL").run(bySeq, targetSeq));
}
