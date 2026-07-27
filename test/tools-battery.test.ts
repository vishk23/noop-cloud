import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { batterySeries } from "../src/tools/granular.js";

// battery_series reads the WhoopStore `battery` table (created in migration v1 with soc/mv, given
// `synced` in v5 and the nullable `charging` in v6). The stock fixture mirror doesn't carry it, so —
// same approach as tools-imu.test.ts — we ingest the standard noopbak and then write the table straight
// into the mirror sqlite in its real v6 shape, while a second mirror WITHOUT it exercises the
// no-battery-table (older/foreign upload) path. `synced` is included deliberately: it's in the real
// schema and must NOT leak into the tool's output, which pins the accessor's explicit column list.
const dataDir = path.join(process.cwd(), "test/.tmp/battery");
const bareDir = path.join(process.cwd(), "test/.tmp/battery-bare");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const bareCfg = { dataDir: bareDir, mirrorPath: path.join(bareDir, "mirror.sqlite"), serverDbPath: path.join(bareDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const T0 = Math.floor(new Date("2026-06-13T12:00:00Z").getTime() / 1000); // on a 300 s bucket boundary

beforeAll(async () => {
  for (const [d, c] of [[dataDir, cfg], [bareDir, bareCfg]] as const) {
    fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
    const z = path.join(d, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), c);
  }
  // Battery goes into the main mirror only. The rows tell the story the tool exists to answer: a strap
  // discharging to death, a silent gap, then a charge — plus a command-response tail where `charging`
  // is null. soc is PERCENT (0-100, one decimal), matching the app-side producer.
  const db = new Database(cfg.mirrorPath);
  db.exec(`CREATE TABLE IF NOT EXISTS battery (deviceId TEXT NOT NULL, ts INTEGER NOT NULL, soc DOUBLE, mv INTEGER, synced INTEGER NOT NULL DEFAULT 0, charging BOOLEAN, PRIMARY KEY(deviceId, ts));`);
  const ins = db.prepare("INSERT INTO battery (deviceId, ts, soc, mv, synced, charging) VALUES (?,?,?,?,?,?)");
  // Bucket A [T0, T0+300): discharging, charging reported false (dense BATTERY_LEVEL path).
  ins.run("my-whoop", T0 + 0, 12.5, 3700, 0, 0);
  ins.run("my-whoop", T0 + 60, 11.0, 3680, 0, 0);
  ins.run("my-whoop", T0 + 120, 9.5, 3660, 0, 0);
  ins.run("my-whoop", T0 + 240, 8.0, 3650, 0, 0);
  // Bucket B [T0+300, T0+600): the last gasp at 1% — then the strap dies and reports nothing.
  ins.run("my-whoop", T0 + 300, 1.0, 3500, 0, 0);
  // ...silence across [T0+600, T0+1800): no rows at all. This gap IS the death.
  // Bucket C [T0+1800, T0+2100): back on the charger, charging reported true, soc climbing.
  ins.run("my-whoop", T0 + 1800, 5.0, 3550, 0, 1);
  ins.run("my-whoop", T0 + 1860, 20.0, 3800, 0, 1);
  ins.run("my-whoop", T0 + 1920, 35.5, 3900, 0, 1);
  // Bucket D [T0+2400, T0+2700): command-response path — `charging` null throughout, and a row whose
  // soc was never read (null) sandwiched between two real ones.
  ins.run("my-whoop", T0 + 2400, 40.0, 3950, 0, null);
  ins.run("my-whoop", T0 + 2460, null, 3960, 0, null);
  ins.run("my-whoop", T0 + 2520, 42.5, 3970, 0, null);
  // A second strap, parked in its own window so it can't disturb the buckets above — deviceId filter.
  ins.run("other-strap", T0 + 3600, 77.0, 4000, 0, 0);
  db.close();
});

const DAY = { from: "2026-06-13T12:00:00Z", to: "2026-06-13T13:00:00Z" };

describe("battery_series", () => {
  it("returns notCaptured on a mirror with no battery table (older/foreign upload)", () => {
    const r = batterySeries(bareCfg, { ...DAY, deviceId: "my-whoop" }) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.samples).toEqual([]);
    expect(r.hint).toMatch(/strap reported none/);
  });

  it("returns notCaptured for a range with no readings, even though the table has rows elsewhere", () => {
    // 2026-06-10 carries other fixture data but no battery rows: absence in range, not a missing table.
    const r = batterySeries(cfg, { from: "2026-06-10T00:00:00Z", to: "2026-06-10T23:59:59Z", deviceId: "my-whoop" }) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.samples).toEqual([]);
  });

  it("uses the mode-appropriate empty key when notCaptured and bucketSeconds was passed", () => {
    const r = batterySeries(bareCfg, { ...DAY, bucketSeconds: 300 }) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.buckets).toEqual([]);
    expect(r.samples).toBeUndefined();
  });

  it("reports soc on a 0-100 PERCENT scale, not a 0-1 fraction", () => {
    const r = batterySeries(cfg, { ...DAY, deviceId: "my-whoop" }) as any;
    const socs = r.samples.map((s: any) => s.soc).filter((s: any) => s != null);
    expect(Math.max(...socs)).toBe(42.5);   // a real one-decimal percent, never rounded to an int
    expect(socs.some((s: number) => s > 1)).toBe(true); // the whole point: 12.5 means 12.5%, not 1250%
  });

  it("returns the raw discharge -> death -> charge story with charging as a real boolean", () => {
    const r = batterySeries(cfg, { ...DAY, deviceId: "my-whoop" }) as any;
    expect(r.notCaptured).toBeUndefined();
    expect(r.samples).toHaveLength(11); // 4 discharging + 1 last gasp + 3 charging + 3 command-response
    expect(r.samples[0]).toEqual({ ts: T0, deviceId: "my-whoop", family: "whoop", soc: 12.5, mv: 3700, charging: false });
    // The last gasp, then the silent gap: the next reading is 1500 s later and already charging.
    const gasp = r.samples.find((s: any) => s.ts === T0 + 300);
    expect(gasp.soc).toBe(1.0);
    expect(gasp.charging).toBe(false);
    const revived = r.samples.find((s: any) => s.ts === T0 + 1800);
    expect(revived.charging).toBe(true);   // normalized from SQLite's 0/1, not passed through as 1
    expect(revived.soc).toBe(5.0);
  });

  it("passes null soc/mv/charging through as null rather than 0", () => {
    const r = batterySeries(cfg, { ...DAY, deviceId: "my-whoop" }) as any;
    const nullSoc = r.samples.find((s: any) => s.ts === T0 + 2460);
    expect(nullSoc.soc).toBeNull();        // a 0 here would read as a flat battery
    expect(nullSoc.mv).toBe(3960);
    expect(nullSoc.charging).toBeNull();   // command-response path: UNKNOWN, not "not charging"
  });

  it("never leaks the `synced` column into samples", () => {
    const r = batterySeries(cfg, { ...DAY, deviceId: "my-whoop" }) as any;
    expect(Object.keys(r.samples[0]).sort()).toEqual(["charging", "deviceId", "family", "mv", "soc", "ts"]);
  });

  it("reports `latest` as the most recent reading in range, carrying its own deviceId", () => {
    const r = batterySeries(cfg, { ...DAY, deviceId: "my-whoop" }) as any;
    expect(r.latest).toEqual({ ts: T0 + 2520, deviceId: "my-whoop", family: "whoop", soc: 42.5, mv: 3970, charging: null });
  });

  it("buckets soc first/last/min/max + mvLast and keeps the discharge direction", () => {
    const r = batterySeries(cfg, { ...DAY, deviceId: "my-whoop", bucketSeconds: 300 }) as any;
    const a = r.buckets.find((b: any) => b.ts === T0);
    expect(a).toEqual({
      ts: T0, deviceId: "my-whoop", family: "whoop",
      socFirst: 12.5, socLast: 8.0, socMin: 8.0, socMax: 12.5, mvLast: 3650, charging: false, n: 4,
    });
    expect(a.socLast).toBeLessThan(a.socFirst); // falling within the bucket = discharging
  });

  it("aggregates charging three-state: true / false / null(unknown)", () => {
    const r = batterySeries(cfg, { ...DAY, deviceId: "my-whoop", bucketSeconds: 300 }) as any;
    const discharge = r.buckets.find((b: any) => b.ts === T0);
    const charge = r.buckets.find((b: any) => b.ts === T0 + 1800);
    const unknown = r.buckets.find((b: any) => b.ts === T0 + 2400);
    expect(discharge.charging).toBe(false);  // every reporting reading said no
    expect(charge.charging).toBe(true);      // any reading reporting charging wins
    expect(charge.socFirst).toBe(5.0);
    expect(charge.socLast).toBe(35.5);       // rising = the charge, visible without a charging flag
    expect(unknown.charging).toBeNull();     // none reported — unknown, NOT false
  });

  it("skips null soc in the bucket aggregates instead of zeroing them", () => {
    const r = batterySeries(cfg, { ...DAY, deviceId: "my-whoop", bucketSeconds: 300 }) as any;
    const d = r.buckets.find((b: any) => b.ts === T0 + 2400);
    expect(d.n).toBe(3);            // the null-soc row still counts as a reading
    expect(d.socFirst).toBe(40.0);
    expect(d.socLast).toBe(42.5);   // the trailing null is skipped, not treated as the last value
    expect(d.socMin).toBe(40.0);    // a null coerced to 0 would have made this 0
    expect(d.mvLast).toBe(3970);
  });

  it("leaves a gap rather than interpolating across the dead stretch", () => {
    const r = batterySeries(cfg, { ...DAY, deviceId: "my-whoop", bucketSeconds: 300 }) as any;
    // Buckets exist only where readings do: nothing fabricated for [T0+600, T0+1800).
    expect(r.buckets.map((b: any) => b.ts)).toEqual([T0, T0 + 300, T0 + 1800, T0 + 2400]);
  });

  it("filters by deviceId, and includes every strap when unfiltered", () => {
    const filtered = batterySeries(cfg, { ...DAY, deviceId: "my-whoop" }) as any;
    expect(filtered.samples.every((s: any) => s.deviceId === "my-whoop")).toBe(true);
    const all = batterySeries(cfg, { ...DAY }) as any;
    expect(all.samples).toHaveLength(12); // my-whoop's 11 + other-strap's 1
    expect(all.latest.deviceId).toBe("other-strap"); // the last reading in range, whoever reported it
  });

  it("rejects a span wider than 7 days", () => {
    const r = batterySeries(cfg, { from: "2026-06-01", to: "2026-06-30", deviceId: "my-whoop" }) as any;
    expect(r.error).toBe("span_too_wide");
    expect(r.maxDays).toBe(7);
  });

  it("rejects an unparseable range", () => {
    const r = batterySeries(cfg, { from: "not-a-date", to: "also-not", deviceId: "my-whoop" }) as any;
    expect(r.error).toBe("bad_range");
  });
});
