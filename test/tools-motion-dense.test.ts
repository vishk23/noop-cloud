import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import { buildMirrorSqlite, buildNoopbakFrom } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { sleepDetail } from "../src/tools/granular.js";

// Dense-session regression for the post-hoc review Critical (2026-07-12): sleep_detail's step/gravity
// reads used RAW_CAP(5000), while a real session carries ~22k motion rows — the read silently
// truncated at 5000, undercounting steps/postureChanges 3-4x with no signal (live: 17 steps / 5
// postureChanges reported against a true 70 / 15). Fixed by raising the cap to MOTION_RAW_CAP(500_000)
// and adding `motion.truncated: true` when a read lands exactly on the cap.
//
// This seeds a SEPARATE mirror copy (own dataDir/cfg), not the shared fixture every other test file
// loads via beforeAll — >6000 extra rows on the shared fixture would slow the whole suite. Built the
// same way make-fixture.ts's own fixtures are: buildMirrorSqlite to a temp path, open writable, INSERT
// the dense rows directly, then zip + ingest — the shared fixture's own pinned row counts/assertions
// (make-fixture.test.ts, mirror.test.ts, etc.) are untouched.
const dataDir = path.join(process.cwd(), "test/.tmp/motion-dense");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;

const DENSE_NIGHT = Math.floor(new Date("2026-06-20T03:00:00Z").getTime() / 1000); // clear of every other fixture day
const STEP_ROWS = 6001;    // 6000 wrap-aware deltas of 1 each -> sum 6000; own read > old RAW_CAP(5000)
const GRAVITY_ROWS = 6200; // > old RAW_CAP(5000); the blip sits at offsets [5700,6000) — entirely past
                            // where an old LIMIT 5000 (ORDER BY ts) read would reach.

beforeAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
  const srcSqlite = path.join(dataDir, "src.sqlite");
  buildMirrorSqlite(srcSqlite);
  const raw = new Database(srcSqlite);
  raw.prepare(`INSERT INTO sleepSession (deviceId,startTs,endTs,efficiency,restingHr,avgHrv,stagesJSON,userEdited,startTsAdjusted)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("my-whoop", DENSE_NIGHT, DENSE_NIGHT + 25200, 90, 51, 70, null, 0, null);
  const stepIns = raw.prepare("INSERT INTO stepSample VALUES (?,?,?,?)");
  const gravIns = raw.prepare("INSERT INTO gravitySample VALUES (?,?,?,?,?,?)");
  raw.transaction(() => {
    // counter climbs by exactly 1 each second, no wraps/gaps: STEP_ROWS-1 deltas of 1 -> sum STEP_ROWS-1.
    for (let i = 0; i < STEP_ROWS; i++) stepIns.run("my-whoop", DENSE_NIGHT + i, i, null);
    // baseline [0,5699] (19 full 300s buckets) -> blip [5700,5999] (1 full bucket) -> baseline
    // [6000,6199] (partial bucket): exactly 2 adjacent-bucket posture changes, both past offset 5000.
    for (let i = 0; i < GRAVITY_ROWS; i++) {
      const blip = i >= 5700 && i < 6000;
      gravIns.run("my-whoop", DENSE_NIGHT + i, blip ? 0.9 : 0.0, 0.0, blip ? 0.2 : 1.0, 0);
    }
  })();
  raw.close();
  const zip = path.join(dataDir, "b.noopbak");
  buildNoopbakFrom(srcSqlite, zip);
  ingestNoopbak(fs.readFileSync(zip), cfg);
});

describe("sleep_detail motion — dense-session regression (post-hoc review Critical)", () => {
  it("returns the FULL step/gravity counts for a >6000-row session, not the old 5000-row-capped ones", () => {
    const r = sleepDetail(cfg, { deviceId: "my-whoop", startTs: DENSE_NIGHT }) as any;
    expect(r.motion).not.toBeNull();
    // The old RAW_CAP(5000) read would see only offsets [0,4999] of each stream: steps -> 4999 deltas
    // of 1 = 4999 (not 6000, a silent ~17% undercount here — real sessions saw 3-4x); gravity -> pure
    // baseline (the blip starts at offset 5700) = 0 posture changes (not 2, a 100% miss).
    expect(r.motion.steps).toBe(STEP_ROWS - 1);
    expect(r.motion.postureChanges).toBe(2);
    expect(r.motion.truncated).toBeUndefined(); // 6001/6200 rows, nowhere near the new 500_000 cap
  });
});
