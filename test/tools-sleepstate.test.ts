import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { sleepStateSeries } from "../src/tools/granular.js";

// sleep_state_series reads the WhoopStore `sleepStateSample` table (per-second band state 0=wake/1=still/
// 2=asleep/3=up). The stock fixture lacks it, so we ingest + write the table in; a bare mirror exercises
// the notCaptured path.
const dataDir = path.join(process.cwd(), "test/.tmp/sleepstate");
const bareDir = path.join(process.cwd(), "test/.tmp/sleepstate-bare");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const bareCfg = { dataDir: bareDir, mirrorPath: path.join(bareDir, "mirror.sqlite"), serverDbPath: path.join(bareDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const T0 = Math.floor(new Date("2026-06-13T12:00:00Z").getTime() / 1000);

beforeAll(() => {
  for (const [d, c] of [[dataDir, cfg], [bareDir, bareCfg]] as const) {
    fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
    const z = path.join(d, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), c);
  }
  const db = new Database(cfg.mirrorPath);
  db.exec(`CREATE TABLE IF NOT EXISTS sleepStateSample (deviceId TEXT, ts INTEGER, state INTEGER, PRIMARY KEY(deviceId, ts));`);
  const ins = db.prepare("INSERT INTO sleepStateSample VALUES (?,?,?)");
  for (let i = 0; i <= 4; i++) ins.run("my-whoop", T0 + i, 0);          // wake, 5s (dur 4)
  for (let i = 5; i <= 14; i++) ins.run("my-whoop", T0 + i, 2);         // asleep, 10s (dur 9)
  ins.run("my-whoop", T0 + 200, 2);                                     // asleep again after a >120s gap
  db.close();
});

describe("sleep_state_series", () => {
  it("returns notCaptured on a mirror without the sleepStateSample table", () => {
    const r = sleepStateSeries(bareCfg, { from: "2026-06-13T00:00:00Z", to: "2026-06-13T23:59:59Z", deviceId: "my-whoop" }) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.segments).toEqual([]);
  });

  it("run-length-encodes states into labelled segments, breaking on a gap", () => {
    const r = sleepStateSeries(cfg, { from: "2026-06-13T12:00:00Z", to: "2026-06-13T12:15:00Z", deviceId: "my-whoop" }) as any;
    expect(r.notCaptured).toBeUndefined();
    expect(r.segments.length).toBe(3); // wake, asleep, then asleep again after the gap
    expect(r.segments[0]).toMatchObject({ state: 0, label: "wake", startTs: T0, endTs: T0 + 4, durationS: 4, family: "whoop" });
    expect(r.segments[1]).toMatchObject({ state: 2, label: "asleep", startTs: T0 + 5, endTs: T0 + 14, durationS: 9 });
    expect(r.segments[2]).toMatchObject({ state: 2, label: "asleep", startTs: T0 + 200, durationS: 0 });
    expect(r.totals).toMatchObject({ wake: 4, asleep: 9 });
    expect(r.dataExtent).toMatchObject({ n: 16 });
  });

  it("rejects a span wider than 7 days", () => {
    const r = sleepStateSeries(cfg, { from: "2026-06-01", to: "2026-06-30", deviceId: "my-whoop" }) as any;
    expect(r.error).toBe("span_too_wide");
  });
});
