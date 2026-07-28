import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import { buildMirrorSqlite, buildNoopbakFrom } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { Mirror } from "../src/mirror.js";
import { streamsInventory } from "../src/tools/core.js";

// hr_series was blind to ppgHrSample (audit, 2026-07-28). The mirror read was `FROM hrSample` alone, so
// the cloud could not see the ~36.8k HR seconds the PHONE counts — Reads.swift unions ppgHrSample into
// `hrSamples`, `hrWindowStats` (workout avg/max), `hrBuckets` (the chart) and the day-has-data gate, and
// Android matches. Worse, the `streams` tool's note called those rows "withdrawn (#194) — instrumentation
// only, intentionally unread", which is false on all three counts and actively told every agent reading
// it to ignore live production data.
//
// These pin the fix AND the invariant that makes it safe: a PPG estimate may only fill a second that has
// NO measured row. Getting that wrong would double-count real beats, which is worse than the bug.
const dataDir = path.join(process.cwd(), "test/.tmp/hr-ppg-union");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;

const T0 = Math.floor(new Date("2026-06-23T04:00:00Z").getTime() / 1000); // clear of every other fixture day

beforeAll(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
  const srcSqlite = path.join(dataDir, "src.sqlite");
  buildMirrorSqlite(srcSqlite);
  const raw = new Database(srcSqlite);
  // Seconds 0..9 measured. Seconds 5..14 have a PPG estimate, so 5..9 OVERLAP a measured second and
  // 10..14 are PPG-only. A correct union yields 15 seconds, not 20.
  const hrIns = raw.prepare("INSERT INTO hrSample VALUES (?,?,?)");
  const ppgIns = raw.prepare("INSERT INTO ppgHrSample VALUES (?,?,?,?)");
  raw.transaction(() => {
    for (let i = 0; i < 10; i++) hrIns.run("my-whoop", T0 + i, 60 + i);
    // 199.6 rounds to 200 — proves the CAST(ROUND(...)) matches the phone rather than truncating to 199.
    for (let i = 5; i < 15; i++) ppgIns.run("my-whoop", T0 + i, i === 12 ? 199.6 : 100 + i, 0.8);
  })();
  raw.close();
  const zip = path.join(dataDir, "b.noopbak");
  buildNoopbakFrom(srcSqlite, zip);
  await ingestNoopbak(fs.readFileSync(zip), cfg);
});

const read = () => {
  const m = new Mirror(cfg.mirrorPath);
  try { return m.hrSamplesRange({ fromTs: T0, toTs: T0 + 100, deviceId: "my-whoop", limit: 10_000 }); }
  finally { m.close(); }
};

describe("hr_series unions ppgHrSample, exactly as the phone does", () => {
  it("returns the PPG-only seconds the measured-only read could not see", () => {
    const rows = read();
    const byTs = new Map(rows.map(r => [r.ts, r.bpm]));
    // 10 measured + 5 PPG-only = 15. The five overlapping PPG rows must NOT appear as extra samples.
    expect(rows.length).toBe(15);
    for (let i = 10; i < 15; i++) {
      expect(byTs.has(T0 + i), `second +${i} is PPG-only and must be present`).toBe(true);
    }
  });

  it("never lets a PPG estimate double-count or override a measured second", () => {
    const rows = read();
    const seen = new Set<number>();
    for (const r of rows) {
      expect(seen.has(r.ts), `ts ${r.ts} appeared twice — the anti-join is not holding`).toBe(false);
      seen.add(r.ts);
    }
    const byTs = new Map(rows.map(r => [r.ts, r.bpm]));
    // Seconds 5..9 have BOTH a measured row (60+i) and a PPG row (100+i). Measured must win.
    for (let i = 5; i < 10; i++) expect(byTs.get(T0 + i)).toBe(60 + i);
  });

  it("rounds the PPG bpm into the Int domain the phone uses, rather than truncating", () => {
    const byTs = new Map(read().map(r => [r.ts, r.bpm]));
    expect(byTs.get(T0 + 12)).toBe(200); // 199.6 -> 200
  });

  it("still returns rows in ts order across both legs", () => {
    const ts = read().map(r => r.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("stops telling agents the rows are withdrawn and unread", () => {
    const inv = streamsInventory(cfg) as any;
    const ppg = inv.streams.find((s: any) => s.table === "ppgHrSample");
    expect(ppg).toBeTruthy();
    expect(ppg.readBy).toBe("hr_series");
    expect(ppg.note).toBeUndefined();
    // And it is a real gap candidate now, so a future regression that unhooks the reader is reported
    // rather than hidden behind an exclusion.
    expect(inv.gaps).not.toContain("ppgHrSample");
  });
});
