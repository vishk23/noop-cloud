import type { Config } from "../config.js";
import { openServerDb } from "../serverdb.js";

type C = Pick<Config, "serverDbPath">;

export interface DeviceTokenRow { token: string; platform: string; updatedAt: number; }

function withDb<T>(cfg: C, fn: (db: ReturnType<typeof openServerDb>) => T): T {
  const db = openServerDb(cfg);
  try { return fn(db); } finally { db.close(); }
}

/** Insert or refresh a device token (re-registering just bumps updatedAt); returns the total registered count. */
export function upsertDeviceToken(cfg: C, token: string, platform: string): number {
  return withDb(cfg, (db) => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO deviceToken (token, platform, updatedAt) VALUES (?,?,?)
                ON CONFLICT(token) DO UPDATE SET platform = excluded.platform, updatedAt = excluded.updatedAt`)
      .run(token, platform, now);
    return (db.prepare("SELECT COUNT(*) AS c FROM deviceToken").get() as { c: number }).c;
  });
}

export function listDeviceTokens(cfg: C): DeviceTokenRow[] {
  return withDb(cfg, (db) => db.prepare("SELECT token, platform, updatedAt FROM deviceToken ORDER BY token").all() as DeviceTokenRow[]);
}

export function countDeviceTokens(cfg: C): number {
  return withDb(cfg, (db) => (db.prepare("SELECT COUNT(*) AS c FROM deviceToken").get() as { c: number }).c);
}

/** Called when APNs reports a token dead (410, or 400 BadDeviceToken) so we stop pushing to it. */
export function deleteDeviceToken(cfg: C, token: string): void {
  withDb(cfg, (db) => { db.prepare("DELETE FROM deviceToken WHERE token = ?").run(token); });
}

// Server-wide push throttle. Single row guarded by pushState's `id = 1` CHECK constraint
// (serverdb.ts) — request_sync (src/tools/push.ts) is rate-limited across all callers, not per-caller.
export function getLastPushAt(cfg: C): number | null {
  return withDb(cfg, (db) => {
    const row = db.prepare("SELECT lastPushAt FROM pushState WHERE id = 1").get() as { lastPushAt: number } | undefined;
    return row?.lastPushAt ?? null;
  });
}

export function setLastPushAt(cfg: C, ts: number): void {
  withDb(cfg, (db) => {
    db.prepare(`INSERT INTO pushState (id, lastPushAt) VALUES (1, ?)
                ON CONFLICT(id) DO UPDATE SET lastPushAt = excluded.lastPushAt`).run(ts);
  });
}
