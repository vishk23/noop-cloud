import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { storageReport } from "../src/storage.js";
import { dataFreshness } from "../src/tools/core.js";

/**
 * The mirror has TWO writers, and freshness was only ever stamped by one of them.
 *
 * `POST /ingest` publishes a whole database by rename(2) and appends an `ingestLog` row. The liters
 * applier writes the SAME file IN PLACE, from the Rust sidecar, and touches no table in
 * server.sqlite — it has no reason to, and cannot be made to without teaching the sink a schema it
 * does not otherwise know. Every freshness number was derived from that one `ingestLog` row, so the
 * moment page replication became the live path (LITERS_SINK_ENABLED=1 in production, 2026-07-30)
 * every one of them froze at the last whole-DB upload while the mirror kept advancing.
 *
 * Measured on vk-noop-cloud, 2026-07-31T14:20Z — a report that contradicts itself in four places:
 *   lastIngestAt            2026-07-30T17:34:06Z   (the last POST /ingest — true)
 *   mirrorAgeSeconds        110857  (~30.8 h)      (derived from the SAME row — false)
 *   mirror.modifiedAt       2026-07-31T14:19:50Z   (mtime — 20.7 h AFTER the "last ingest")
 *   liters.lastSyncAtMs     1785507590868          = 14:19:50.868Z, applies: 10
 *   latestDataDay           2026-07-31             (samples through 12:41Z)
 *
 * It matters because `data_freshness` is the noop-health skill's mandatory first call and the >36 h
 * branch tells the agent to warn that "the answer describes old data". It fired on data a few hours
 * old. The same marker drives a 48 h server-side warning, which under replication would have gone
 * off on a perfectly healthy server the next day.
 *
 * So freshness is derived from GROUND TRUTH — the mirror's own mtime — which no writer can forget to
 * update, rather than from a marker one writer does not know exists. `Mirror` opens `readonly: true`
 * at all 20 call sites, so no read can move that mtime; only a write does.
 */

const dataDir = path.join(process.cwd(), "test/.tmp/freshness-ground-truth");
const mirrorPath = path.join(dataDir, "mirror.sqlite");
const serverDbPath = path.join(dataDir, "server.sqlite");
const statusPath = path.join(dataDir, "liters-sink-status.json");
const cfg = () => ({
  dataDir, mirrorPath, serverDbPath,
  maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0,
  liters: { enabled: true, statusPath, bucketDir: path.join(dataDir, "ltx-bucket") },
} as any);

/**
 * The status file the Rust sink republishes after every apply round — the sink's OWN stamp of when
 * it last wrote the mirror, already read by `/status` and `/healthz` (src/liters/state.ts). Used for
 * attribution only: freshness itself never depends on it, so a missing or torn file costs a label,
 * never a correct age.
 */
function publishLitersStatus(lastSyncAtMs: number): void {
  fs.writeFileSync(statusPath, JSON.stringify({
    ok: true, position: 18, bucketMax: 18, lastSyncAtMs, lastError: null, lockBusy: false,
    applies: 10, lockBusyTotal: 0, errorsTotal: 0, freeBytes: 1e9, bucketBytes: 1e6,
    mirrorBytes: 1e6, spaceOk: true, sweptTotal: 0, startedAtMs: lastSyncAtMs - 60_000, minFreeBytes: 1e6,
  }));
}

/** Path 1 — the whole-DB upload. Publishes by rename(2) and appends an `ingestLog` row. */
async function ingestPath(): Promise<void> {
  const zip = path.join(dataDir, "b.noopbak");
  buildNoopbak(zip);
  await ingestNoopbak(fs.readFileSync(zip), cfg());
  fs.rmSync(zip, { force: true });
}

/**
 * Path 2 — what the liters applier does: open the mirror read-write, write pages, close. No
 * `ingestLog` row, because the sink is a separate Rust process that never opens server.sqlite.
 *
 * `journal_mode = DELETE` is not a test detail. It is the mode the applier leaves the file in (see
 * test/liters-readers.test.ts), and it is what makes the write land in the main database file — so
 * the mirror's own mtime moves, which is the signal this whole fix rests on.
 */
function litersApplyPath(ts: number): void {
  const w = new Database(mirrorPath);
  try {
    w.pragma("journal_mode = DELETE");
    w.prepare("INSERT OR REPLACE INTO hrSample (deviceId, ts, bpm) VALUES (?,?,?)").run("my-whoop", ts, 58);
  } finally { w.close(); }
  for (const s of ["-wal", "-shm"]) fs.rmSync(mirrorPath + s, { force: true });
}

/** Rewrite the one `ingestLog` row to look `hours` old — the drift the real incident had. */
function backdateIngestLog(hours: number): void {
  const db = new Database(serverDbPath);
  try {
    db.prepare("UPDATE ingestLog SET receivedAt = ?")
      .run(Math.floor(Date.now() / 1000) - Math.round(hours * 3600));
  } finally { db.close(); }
}

/** Move the mirror's mtime back, so a genuinely stale mirror can be distinguished from a fresh one. */
function backdateMirrorMtime(hours: number): void {
  const t = new Date(Date.now() - hours * 3_600_000);
  fs.utimesSync(mirrorPath, t, t);
}

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

describe("reported freshness is derived from the mirror, not from the ingest marker", () => {
  it("advances when POST /ingest writes the mirror", async () => {
    await ingestPath();
    const r: any = dataFreshness(cfg());
    expect(r.mirrorAgeSeconds).toBeLessThan(60);
    expect(r.lastIngestAt).toBeTruthy();
  });

  it("advances when the liters applier writes the mirror, which stamps no ingestLog row", async () => {
    await ingestPath();
    // The incident's starting state: the last whole-DB upload really was 30.8 h ago, and until
    // replication ran the mirror really was that stale. Both are old, and the report says so.
    backdateIngestLog(30.8);
    backdateMirrorMtime(30.8);
    expect((dataFreshness(cfg()) as any).mirrorAgeSeconds).toBeGreaterThan(100_000);

    litersApplyPath(Math.floor(Date.now() / 1000));

    // The mirror was written seconds ago. Nothing appended to ingestLog, and nothing should have to.
    const r: any = dataFreshness(cfg());
    expect(r.mirrorAgeSeconds).toBeLessThan(60);
  });

  it("keeps lastIngestAt meaning the last whole-DB upload, so the two numbers can disagree honestly", async () => {
    await ingestPath();
    backdateIngestLog(30.8);
    litersApplyPath(Math.floor(Date.now() / 1000));

    const r: any = dataFreshness(cfg());
    // Not folded together: `lastIngestAt` answers "when did the phone last send the WHOLE database",
    // which is a real operational question and is genuinely 30.8 h ago here. The fix is that it no
    // longer masquerades as the mirror's age.
    expect(Date.now() - Date.parse(r.lastIngestAt)).toBeGreaterThan(30 * 3_600_000);
    expect(r.mirrorAgeSeconds).toBeLessThan(60);
  });

  it("reports when the mirror was last written, alongside how long ago", async () => {
    await ingestPath();
    litersApplyPath(Math.floor(Date.now() / 1000));
    const r: any = dataFreshness(cfg());
    expect(Date.now() - Date.parse(r.mirrorUpdatedAt)).toBeLessThan(60_000);
  });
});

/**
 * The mirror's mtime answers "was the file written". It does not answer "did new DATA arrive" — an
 * apply that touches only bookkeeping pages moves the mtime and adds no samples. `latestDataDay`
 * already answered the data question at DAY granularity; this is the same answer in seconds, taken
 * from MAX(ts) over the raw sample tables `Mirror.sources()` already aggregates, so it costs nothing
 * new. It is the number that actually justifies "the answer describes old data".
 */
describe("data age is measured from the newest sample, not from the file's mtime", () => {
  it("reports the newest raw sample, which is far older than a just-written mirror", async () => {
    await ingestPath();
    const r: any = dataFreshness(cfg());
    // The fixture's newest sample is 2026-06-13, so on any real clock the DATA is old even though
    // the file was written a moment ago. Those are different questions and now have different answers.
    expect(r.latestSampleAt.slice(0, 10)).toBe("2026-06-13");
    expect(r.dataAgeSeconds).toBeGreaterThan(r.mirrorAgeSeconds);
  });

  it("advances when replication lands a newer sample", async () => {
    await ingestPath();
    const now = Math.floor(Date.now() / 1000);
    litersApplyPath(now);

    const r: any = dataFreshness(cfg());
    expect(Date.parse(r.latestSampleAt)).toBe(now * 1000);
    expect(r.dataAgeSeconds).toBeLessThan(60);
  });

  it("does not advance when a write lands no new samples", async () => {
    await ingestPath();
    const before: any = dataFreshness(cfg());

    // A write that touches the database without adding a sample — the case an mtime cannot tell
    // apart from a real delivery, and the reason data age is measured separately.
    const w = new Database(mirrorPath);
    try { w.pragma("journal_mode = DELETE"); w.exec("PRAGMA user_version = 42"); } finally { w.close(); }

    const after: any = dataFreshness(cfg());
    expect(after.mirrorAgeSeconds).toBeLessThan(60);
    expect(after.latestSampleAt).toBe(before.latestSampleAt);
  });

  // Formatting the day in JS instead of in SQLite trades one failure mode for another: SQLite's
  // `date(ts,'unixepoch')` answers NULL for a timestamp it cannot represent, while
  // `new Date(ts*1000).toISOString()` THROWS. A single corrupt row must not be able to take down the
  // tool the whole skill contract calls first — that is the 2026-07-26 lesson in a new dimension.
  it("survives a corrupt timestamp instead of throwing", async () => {
    await ingestPath();
    const w = new Database(mirrorPath);
    try {
      w.pragma("journal_mode = DELETE");
      w.prepare("INSERT OR REPLACE INTO hrSample (deviceId, ts, bpm) VALUES (?,?,?)").run("my-whoop", 9e18, 60);
    } finally { w.close(); }

    const r: any = dataFreshness(cfg());
    // The unrepresentable value is dropped rather than propagated or thrown, so it degrades the one
    // source that holds it and nothing else: every other number in the report still lands.
    expect(Number.isNaN(Date.parse(r.latestSampleAt))).toBe(false);
    expect(Date.parse(r.latestSampleAt)).toBeLessThan(Date.now() + 86_400_000);
    expect(r.mirrorAgeSeconds).toBeLessThan(60);
    expect(r.sources.length).toBeGreaterThan(0);
  });
});

/**
 * Why the report contradicted itself was never derivable FROM the report: `lastIngestAt` said 30.8 h
 * and the mirror said 40 s, with nothing naming the writer that closed the gap. Each path's own
 * stamp is surfaced so the disagreement reads as replication rather than as a bug.
 */
describe("the report names which path last wrote the mirror", () => {
  it("attributes a whole-DB upload to ingest", async () => {
    await ingestPath();
    const r: any = dataFreshness(cfg());
    expect(r.lastWriteSource).toBe("ingest");
    expect(r.lastReplicationAt).toBeNull();
  });

  // Caught in production one minute after this fix deployed. The sink republishes `lastSyncAtMs: 0`
  // until its FIRST apply of the process — documented behaviour, see statusAgeSeconds in
  // src/liters/state.ts — so every deploy resets it. That made a mirror the applier had written 5.9 h
  // earlier report `lastWriteSource: "ingest"` against a 2.1-day-old upload: a field stating
  // something the two timestamps beside it flatly contradict, which is the exact defect class this
  // whole change exists to remove. The stamps are hints; the mtime is the evidence.
  it("attributes to replication after a sink restart has zeroed lastSyncAtMs", async () => {
    await ingestPath();
    backdateIngestLog(51);              // the last whole-DB upload, 2.1 days ago
    litersApplyPath(Math.floor(Date.now() / 1000));
    publishLitersStatus(0);             // a restarted, idle, perfectly healthy sink

    const r: any = dataFreshness(cfg());
    expect(r.lastWriteSource).toBe("replication");
    expect(r.lastReplicationAt).toBeNull(); // honest: the sink has not applied in THIS process
  });

  it("attributes a newer liters apply to replication, using the sink's own published status", async () => {
    await ingestPath();
    backdateIngestLog(30.8);
    litersApplyPath(Math.floor(Date.now() / 1000));
    publishLitersStatus(Date.now());

    const r: any = dataFreshness(cfg());
    expect(r.lastWriteSource).toBe("replication");
    expect(Date.now() - Date.parse(r.lastReplicationAt)).toBeLessThan(60_000);
  });
});

describe("freshness survives a mirror that cannot be read", () => {
  it("still reports when the mirror was last written", async () => {
    await ingestPath();
    // Corrupt the mirror in place. Every mirror-backed read now fails, but the file is still there
    // and stat(2) still works — so the one question `data_freshness` exists to answer is still
    // answerable, and an operator staring at a degraded server should not also be told "unknown".
    fs.writeFileSync(mirrorPath, Buffer.alloc(4096, 0x7f));

    const r: any = dataFreshness(cfg());
    expect(r.degraded).toBe(true);
    expect(r.mirrorAgeSeconds).toBeLessThan(60);
    expect(Date.now() - Date.parse(r.mirrorUpdatedAt)).toBeLessThan(60_000);
  });
});

describe("the staleness warning follows the mirror, not the ingest marker", () => {
  it("stays silent while replication is keeping a fresh mirror without any /ingest", async () => {
    await ingestPath();
    backdateIngestLog(72); // three days since the last whole-DB upload — past the 48 h threshold
    litersApplyPath(Math.floor(Date.now() / 1000));

    const s = storageReport(cfg());
    // The false alarm this fix exists to stop: the mirror is seconds old and every tool is answering
    // with today's data, so "the phone's uploads are failing" is simply untrue.
    expect(s.warnings.filter((w) => /no successful ingest|stale/i.test(w))).toEqual([]);
    expect(s.ok).toBe(true);
  });

  it("still fires when the mirror itself has not been written for days", async () => {
    await ingestPath();
    backdateIngestLog(72);
    backdateMirrorMtime(72);

    const s = storageReport(cfg());
    // The failure mode that must NOT be traded away for the one above: a genuinely dead server has
    // to keep saying so. Neither path has written the mirror in three days.
    expect(s.warnings.some((w) => /not been updated|stale/i.test(w))).toBe(true);
    expect(s.ok).toBe(false);
  });
});
