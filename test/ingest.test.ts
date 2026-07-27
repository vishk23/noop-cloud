import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path"; import Database from "better-sqlite3"; import AdmZip from "adm-zip";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak, latestIngest, IngestError, normalizePhoneTz } from "../src/ingest.js";

const dataDir = path.join(process.cwd(), "test/.tmp/ingest");
const cfg = () => ({ dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any);
beforeEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

describe("ingest", () => {
  it("accepts a valid .noopbak and swaps the mirror", async () => {
    const zip = path.join(dataDir, "in.noopbak"); buildNoopbak(zip);
    const r = await ingestNoopbak(fs.readFileSync(zip), cfg());
    expect(r.ok).toBe(true); expect(r.latestDay).toBe("2026-06-13");
    const db = new Database(cfg().mirrorPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM dailyMetric").get() as any).c).toBeGreaterThan(0); db.close();
    expect(latestIngest(cfg())?.latestDay).toBe("2026-06-13");
  });
  it("rejects oversized", async () => {
    const c = cfg(); c.maxIngestBytes = 10;
    await expect(ingestNoopbak(Buffer.alloc(100), c)).rejects.toThrow(IngestError);
  });
  it("rejects a zip with no sqlite entry", async () => {
    const z = new AdmZip(); z.addFile("notes.txt", Buffer.from("hi"));
    try { await ingestNoopbak(z.toBuffer(), cfg()); expect.fail("should throw"); }
    catch (e: any) { expect(e.code).toBe("no_sqlite_entry"); }
  });
  it("rejects a foreign sqlite (no grdb_migrations)", async () => {
    const foreign = path.join(dataDir, "f.sqlite"); const db = new Database(foreign); db.exec("CREATE TABLE x(a)"); db.close();
    const z = new AdmZip(); z.addFile("noop-backup.sqlite", fs.readFileSync(foreign));
    try { await ingestNoopbak(z.toBuffer(), cfg()); expect.fail("should throw"); }
    catch (e: any) { expect(e.code).toBe("foreign_db"); }
  });
  it("does not corrupt an existing mirror when the new upload is invalid", async () => {
    const zip = path.join(dataDir, "ok.noopbak"); buildNoopbak(zip); await ingestNoopbak(fs.readFileSync(zip), cfg());
    try { await ingestNoopbak(Buffer.from("not a zip"), cfg()); } catch { /* expected */ }
    const db = new Database(cfg().mirrorPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM dailyMetric").get() as any).c).toBeGreaterThan(0); db.close();
  });
  it("stores a valid phone timezone on the ingestLog row", async () => {
    const zip = path.join(dataDir, "tz.noopbak"); buildNoopbak(zip);
    await ingestNoopbak(fs.readFileSync(zip), cfg(), "America/Los_Angeles");
    expect(latestIngest(cfg())?.phoneTz).toBe("America/Los_Angeles");
  });
  it("stores NULL phoneTz when none is supplied (default)", async () => {
    const zip = path.join(dataDir, "notz.noopbak"); buildNoopbak(zip);
    await ingestNoopbak(fs.readFileSync(zip), cfg());
    expect(latestIngest(cfg())?.phoneTz ?? null).toBeNull();
  });
  it("normalizePhoneTz accepts IANA ids and UTC, rejects everything else", () => {
    expect(normalizePhoneTz("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(normalizePhoneTz("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
    expect(normalizePhoneTz("UTC")).toBe("UTC");
    expect(normalizePhoneTz("")).toBeNull();
    expect(normalizePhoneTz("-07:00")).toBeNull();
    expect(normalizePhoneTz("'; DROP TABLE ingestLog;--")).toBeNull();
    expect(normalizePhoneTz(undefined)).toBeNull();
    expect(normalizePhoneTz(42)).toBeNull();
  });
  it("does not corrupt an existing mirror when a later upload fails AFTER staging (foreign db)", async () => {
    const zip = path.join(dataDir, "ok2.noopbak"); buildNoopbak(zip); await ingestNoopbak(fs.readFileSync(zip), cfg());
    const foreign = path.join(dataDir, "f2.sqlite"); const fdb = new Database(foreign); fdb.exec("CREATE TABLE x(a)"); fdb.close();
    const z = new AdmZip(); z.addFile("noop-backup.sqlite", fs.readFileSync(foreign));
    try { await ingestNoopbak(z.toBuffer(), cfg()); expect.fail("should throw"); }
    catch (e: any) { expect(e.code).toBe("foreign_db"); }
    const db = new Database(cfg().mirrorPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM dailyMetric").get() as any).c).toBeGreaterThan(0); db.close();
  });
});

import http from "node:http"; import { createApp } from "../src/server.js";
it("POST /ingest requires rw and swaps the mirror", async () => {
  process.env.RO_TOKEN = "ro".padEnd(40, "x"); process.env.RW_TOKEN = "rw".padEnd(40, "y");
  const c = cfg(); c.roToken = process.env.RO_TOKEN; c.rwToken = process.env.RW_TOKEN; c.port = 0;
  const zip = path.join(dataDir, "http.noopbak"); buildNoopbak(zip); const body = fs.readFileSync(zip);
  const app = createApp(c); const server = app.listen(0); const port = (server.address() as any).port;
  const status = await new Promise<number>((resolve) => {
    const r = http.request({ port, path: "/ingest", method: "POST", headers: { authorization: `Bearer ${c.rwToken}`, "content-type": "application/octet-stream" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    r.end(body);
  });
  server.close(); expect(status).toBe(200);
});

it("POST /ingest stores a valid X-Phone-Timezone header and NULLs a malformed one", async () => {
  process.env.RO_TOKEN = "ro".padEnd(40, "x"); process.env.RW_TOKEN = "rw".padEnd(40, "y");
  const c = cfg(); c.roToken = process.env.RO_TOKEN; c.rwToken = process.env.RW_TOKEN; c.port = 0;
  const zip = path.join(dataDir, "tzhdr.noopbak"); buildNoopbak(zip); const body = fs.readFileSync(zip);
  const app = createApp(c); const server = app.listen(0); const port = (server.address() as any).port;
  const post = (tz: string | undefined) => new Promise<number>((resolve) => {
    const headers: any = { authorization: `Bearer ${c.rwToken}`, "content-type": "application/octet-stream" };
    if (tz !== undefined) headers["x-phone-timezone"] = tz;
    const r = http.request({ port, path: "/ingest", method: "POST", headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    r.end(body);
  });

  expect(await post("America/New_York")).toBe(200);
  expect(latestIngest(c)?.phoneTz).toBe("America/New_York");

  // A malformed header must be stored as NULL, never persisted verbatim.
  expect(await post("Pacific Time (bogus)")).toBe(200);
  expect(latestIngest(c)?.phoneTz ?? null).toBeNull();
  server.close();
});

it("POST /ingest with an oversized body returns 413 JSON, not an HTML error page", async () => {
  process.env.RO_TOKEN = "ro".padEnd(40, "x"); process.env.RW_TOKEN = "rw".padEnd(40, "y");
  const c = cfg(); c.roToken = process.env.RO_TOKEN; c.rwToken = process.env.RW_TOKEN; c.port = 0; c.maxIngestBytes = 10;
  const body = Buffer.alloc(1000);
  const app = createApp(c); const server = app.listen(0); const port = (server.address() as any).port;
  const { status, contentType, json } = await new Promise<{ status: number; contentType: string | undefined; json: any }>((resolve) => {
    const r = http.request({ port, path: "/ingest", method: "POST", headers: { authorization: `Bearer ${c.rwToken}`, "content-type": "application/octet-stream" } }, (res) => {
      let d = ""; res.on("data", (chunk) => (d += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, contentType: res.headers["content-type"], json: JSON.parse(d) }));
    });
    r.end(body);
  });
  server.close();
  expect(status).toBe(413);
  expect(contentType).toMatch(/application\/json/);
  expect(json).toEqual({ error: "too_large" });
});
