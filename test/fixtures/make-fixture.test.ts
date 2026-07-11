import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import AdmZip from "adm-zip";
import { buildMirrorSqlite, buildNoopbak } from "./make-fixture.js";

const tmp = path.join(process.cwd(), "test/.tmp");
beforeAll(() => fs.mkdirSync(tmp, { recursive: true }));

describe("fixtures", () => {
  it("mirror has multi-source dailyMetric rows and grdb_migrations", () => {
    const p = path.join(tmp, "m.sqlite");
    buildMirrorSqlite(p);
    const db = new Database(p, { readonly: true });
    const sources = db.prepare("SELECT DISTINCT deviceId FROM dailyMetric ORDER BY deviceId").all().map((r: any) => r.deviceId);
    expect(sources).toContain("oura-api");
    expect(sources).toContain("apple-health");
    expect(sources.some((s: string) => s !== "oura-api" && s !== "apple-health")).toBe(true);
    expect(db.prepare("SELECT count(*) c FROM grdb_migrations").get() as any).toHaveProperty("c");
    db.close();
  });

  it("noopbak is a zip whose FIRST entry is noop-backup.sqlite", () => {
    const p = path.join(tmp, "b.noopbak");
    buildNoopbak(p);
    const entries = new AdmZip(p).getEntries();
    expect(entries[0].entryName).toBe("noop-backup.sqlite");
  });

  it("workout rows have non-null epoch timestamps (2-digit hours)", () => {
    const p = path.join(tmp, "m2.sqlite");
    buildMirrorSqlite(p);
    const db = new Database(p, { readonly: true });
    const rows = db.prepare("SELECT startTs, endTs FROM workout").all() as any[];
    db.close();
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.startTs).toBeGreaterThan(1_700_000_000);
      expect(r.endTs).toBeGreaterThan(r.startTs);
    }
  });
});
