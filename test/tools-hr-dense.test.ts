import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import { buildMirrorSqlite, buildNoopbakFrom } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { sleepDetail } from "../src/tools/granular.js";

// Dense-HR regression (audit-exposed, 2026-07-13): sleep_detail's hrDuringSleep used a raw
// `ORDER BY ts LIMIT RAW_CAP(5000)` fetch, so a real 6.4h/1Hz night (~23k samples) silently returned
// only its first ~83 minutes with no signal the tail was missing — this misled a live investigation.
// Fixed by fetching up to HR_DETAIL_RAW_CAP(250_000) and evenly decimating down to RAW_CAP(5000)
// (stride = ceil(n/5000)) instead of head-truncating, flagging hrDecimated/hrStride/hrTotalSamples.
//
// Separate mirror/dataDir (own cfg), same reasoning as tools-motion-dense.test.ts: >20000 extra HR
// rows on the shared fixture would slow the whole suite and skew its pinned counts.
const dataDir = path.join(process.cwd(), "test/.tmp/hr-dense");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;

const DENSE_NIGHT = Math.floor(new Date("2026-06-21T02:00:00Z").getTime() / 1000); // clear of every other fixture day
const HR_ROWS = 23_040; // 6.4h at 1Hz — matches the real night that exposed the bug

beforeAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
  const srcSqlite = path.join(dataDir, "src.sqlite");
  buildMirrorSqlite(srcSqlite);
  const raw = new Database(srcSqlite);
  raw.prepare(`INSERT INTO sleepSession (deviceId,startTs,endTs,efficiency,restingHr,avgHrv,stagesJSON,userEdited,startTsAdjusted)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("my-whoop", DENSE_NIGHT, DENSE_NIGHT + HR_ROWS, 90, 51, 70, null, 0, null);
  const hrIns = raw.prepare("INSERT INTO hrSample VALUES (?,?,?)");
  raw.transaction(() => {
    for (let i = 0; i < HR_ROWS; i++) hrIns.run("my-whoop", DENSE_NIGHT + i, 50 + (i % 20)); // one bpm sample per second
  })();
  raw.close();
  const zip = path.join(dataDir, "b.noopbak");
  buildNoopbakFrom(srcSqlite, zip);
  ingestNoopbak(fs.readFileSync(zip), cfg);
});

describe("sleep_detail HR — dense-session decimation (audit-exposed)", () => {
  it("evenly decimates a >5000-sample night across the FULL window instead of truncating to its start", () => {
    const r = sleepDetail(cfg, { deviceId: "my-whoop", startTs: DENSE_NIGHT }) as any;
    expect(r.hrDecimated).toBe(true);
    expect(r.hrTotalSamples).toBe(HR_ROWS);
    const expectedStride = Math.ceil(HR_ROWS / 5000); // 5
    expect(r.hrStride).toBe(expectedStride);
    expect(r.hrDuringSleep.length).toBeLessThanOrEqual(5000);
    expect(r.hrDuringSleep.length).toBeGreaterThan(4000); // not the old ~83-minute head-truncation
    // Old head-truncated behavior would never see samples past DENSE_NIGHT + RAW_CAP-1 (~83min in);
    // the fix must reach samples close to the true end of the session.
    const lastTs = r.hrDuringSleep[r.hrDuringSleep.length - 1].ts;
    expect(lastTs).toBeGreaterThan(DENSE_NIGHT + HR_ROWS - 100);
    expect(r.hrDuringSleep[0].ts).toBe(DENSE_NIGHT); // window start always kept
  });
});
