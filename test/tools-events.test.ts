import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { deviceEvents } from "../src/tools/granular.js";

// device_events reads the WhoopStore `event` table (created in migration v1, given `synced` in v5). The
// stock fixture mirror doesn't carry it, so — same approach as tools-imu/tools-battery — we ingest the
// standard noopbak and then write the table straight into the mirror sqlite in its real shape, while a
// second mirror WITHOUT it exercises the no-event-table (older/foreign upload) path. `synced` is
// included deliberately: it's in the real schema and must NOT leak into the tool's output.
//
// The `kind` spellings and the payload shape here are copied from VK's live 11 457-row mirror, not
// invented: decoded events are "LABEL(opcode)", undecoded ones are "0xNN(opcode)", and BATTERY_LEVEL(3)
// is the ONLY kind that carries a non-empty payload.
const dataDir = path.join(process.cwd(), "test/.tmp/events");
const bareDir = path.join(process.cwd(), "test/.tmp/events-bare");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const bareCfg = { dataDir: bareDir, mirrorPath: path.join(bareDir, "mirror.sqlite"), serverDbPath: path.join(bareDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const T0 = Math.floor(new Date("2026-06-13T12:00:00Z").getTime() / 1000);

beforeAll(() => {
  for (const [d, c] of [[dataDir, cfg], [bareDir, bareCfg]] as const) {
    fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
    const z = path.join(d, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), c);
  }
  const db = new Database(cfg.mirrorPath);
  db.exec(`CREATE TABLE IF NOT EXISTS event (deviceId TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, payloadJSON TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (deviceId, ts, kind));`);
  const ins = db.prepare("INSERT INTO event (deviceId, ts, kind, payloadJSON, synced) VALUES (?,?,?,?,?)");
  // A night's story: strap comes off the charger, goes on the wrist, reboots mid-window (losing its
  // clock), then comes off. Payloads are "{}" exactly as the real producer writes them.
  ins.run("my-whoop", T0 + 0, "CHARGING_OFF(8)", "{}", 0);
  ins.run("my-whoop", T0 + 30, "WRIST_ON(9)", "{}", 0);
  ins.run("my-whoop", T0 + 60, "BLE_CONNECTION_UP(11)", "{}", 0);
  ins.run("my-whoop", T0 + 120, "BOOT(15)", "{}", 0);
  ins.run("my-whoop", T0 + 121, "RTC_LOST(13)", "{}", 0);
  ins.run("my-whoop", T0 + 122, "FLASH_INIT_COMPLETE(28)", "{}", 0);
  ins.run("my-whoop", T0 + 300, "BLE_CONNECTION_DOWN(12)", "{}", 0);
  ins.run("my-whoop", T0 + 900, "WRIST_OFF(10)", "{}", 0);
  // The one kind that carries fields — verbatim from the live mirror.
  ins.run("my-whoop", T0 + 180, "BATTERY_LEVEL(3)", '{"battery_charging":0,"battery_mV":3685,"battery_pct":10.9}', 0);
  // Undecoded events: the schema has no name for opcode 110/123, so the strap's report comes through as
  // a hex kind. These are real signal and among the most common kinds on a live WHOOP 5.
  ins.run("my-whoop", T0 + 200, "0x6E(110)", "{}", 0);
  ins.run("my-whoop", T0 + 201, "0x7B(123)", "{}", 0);
  // A malformed payload — must surface as payloadRaw, not crash or get silently dropped.
  ins.run("my-whoop", T0 + 400, "STRAP_CONDITION_REPORT(29)", "not json", 0);
  // A second strap, parked outside the queried window so it can't disturb the counts above.
  ins.run("other-strap", T0 + 7200, "WRIST_ON(9)", "{}", 0);
  db.close();
});

const WIN = { from: "2026-06-13T12:00:00Z", to: "2026-06-13T12:30:00Z" };

describe("device_events", () => {
  it("returns notCaptured on a mirror with no event table (older/foreign upload)", () => {
    const r = deviceEvents(bareCfg, { ...WIN, deviceId: "my-whoop" }) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.counts).toEqual([]);
    expect(r.events).toEqual([]);
    expect(r.hint).toMatch(/strap reported none/);
  });

  it("returns notCaptured for a range with no events, even though the table has rows elsewhere", () => {
    const r = deviceEvents(cfg, { from: "2026-06-10T00:00:00Z", to: "2026-06-10T23:59:59Z", deviceId: "my-whoop" }) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.counts).toEqual([]);
  });

  it("omits the events key entirely when countsOnly and there is no data", () => {
    const r = deviceEvents(bareCfg, { ...WIN, countsOnly: true }) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.counts).toEqual([]);
    expect(r.events).toBeUndefined();
  });

  it("splits kind into label + opcode, keeping the raw kind verbatim", () => {
    const r = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop" }) as any;
    const wristOn = r.events.find((e: any) => e.ts === T0 + 30);
    expect(wristOn.kind).toBe("WRIST_ON(9)");   // the real stored spelling, unchanged
    expect(wristOn.label).toBe("WRIST_ON");
    expect(wristOn.opcode).toBe(9);
    expect(wristOn.family).toBe("whoop");
  });

  it("parses an undecoded 0xNN kind as real signal, not corruption", () => {
    const r = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop" }) as any;
    const undecoded = r.events.find((e: any) => e.ts === T0 + 200);
    expect(undecoded.kind).toBe("0x6E(110)");
    expect(undecoded.label).toBe("0x6E");
    expect(undecoded.opcode).toBe(110); // 0x6E — the decimal opcode, recovered from the parens
  });

  it("omits payload for the '{}' kinds and returns it only for BATTERY_LEVEL", () => {
    const r = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop" }) as any;
    const wristOn = r.events.find((e: any) => e.ts === T0 + 30);
    expect("payload" in wristOn).toBe(false); // a {} on every row would be pure noise
    const battery = r.events.find((e: any) => e.ts === T0 + 180);
    expect(battery.payload).toEqual({ battery_charging: 0, battery_mV: 3685, battery_pct: 10.9 });
  });

  it("surfaces an unparseable payload as payloadRaw rather than dropping the event", () => {
    const r = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop" }) as any;
    const bad = r.events.find((e: any) => e.ts === T0 + 400);
    expect(bad.payloadRaw).toBe("not json");
    expect(bad.payload).toBeUndefined();
    expect(bad.label).toBe("STRAP_CONDITION_REPORT"); // the event itself still counts
  });

  it("never leaks the `synced` column into events", () => {
    const r = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop" }) as any;
    const wristOn = r.events.find((e: any) => e.ts === T0 + 30);
    expect(Object.keys(wristOn).sort()).toEqual(["deviceId", "family", "kind", "label", "opcode", "ts"]);
  });

  it("returns the reboot story in time order", () => {
    const r = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop" }) as any;
    expect(r.events.map((e: any) => e.label)).toEqual([
      "CHARGING_OFF", "WRIST_ON", "BLE_CONNECTION_UP", "BOOT", "RTC_LOST", "FLASH_INIT_COMPLETE",
      "BATTERY_LEVEL", "0x6E", "0x7B", "BLE_CONNECTION_DOWN", "STRAP_CONDITION_REPORT", "WRIST_OFF",
    ]);
  });

  it("counts every kind over the range with first/last timestamps", () => {
    const r = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop" }) as any;
    const boot = r.counts.find((c: any) => c.label === "BOOT");
    expect(boot).toEqual({ kind: "BOOT(15)", label: "BOOT", opcode: 15, n: 1, firstTs: T0 + 120, lastTs: T0 + 120 });
    // 12 my-whoop events in the window, all distinct kinds.
    expect(r.counts).toHaveLength(12);
    expect(r.counts.reduce((a: number, c: any) => a + c.n, 0)).toBe(12);
  });

  it("filters by kinds using a bare LABEL", () => {
    const r = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop", kinds: ["WRIST_ON", "WRIST_OFF"] }) as any;
    expect(r.events).toHaveLength(2);
    expect(r.events.map((e: any) => e.label)).toEqual(["WRIST_ON", "WRIST_OFF"]);
  });

  it("filters by kinds using the FULL kind spelling", () => {
    const r = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop", kinds: ["BOOT(15)"] }) as any;
    expect(r.events).toHaveLength(1);
    expect(r.events[0].opcode).toBe(15);
  });

  it("filters an undecoded hex kind by either spelling", () => {
    const byLabel = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop", kinds: ["0x6E"] }) as any;
    const byKind = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop", kinds: ["0x6E(110)"] }) as any;
    expect(byLabel.events).toHaveLength(1);
    expect(byKind.events).toHaveLength(1);
    expect(byLabel.events[0].kind).toBe("0x6E(110)");
  });

  it("treats `_` in a label as a literal, not a LIKE wildcard", () => {
    // "WRIST_ON" must not match via LIKE semantics where _ is any char. Pin the escape-free
    // substr/instr filter: a label with _ replaced by a wildcard-ish char matches nothing.
    const r = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop", kinds: ["WRISTXON"] }) as any;
    expect(r.notCaptured).toBe(true);
  });

  it("counts stay scoped to the kinds filter", () => {
    const r = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop", kinds: ["BOOT", "RTC_LOST"] }) as any;
    expect(r.counts.map((c: any) => c.label).sort()).toEqual(["BOOT", "RTC_LOST"]);
  });

  it("reports notCaptured when the kinds filter matches nothing, and says so in the hint", () => {
    const r = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop", kinds: ["NO_SUCH_EVENT"] }) as any;
    expect(r.notCaptured).toBe(true);
    expect(r.hint).toMatch(/filtered everything out/);
  });

  it("countsOnly returns the summary without the event list", () => {
    const r = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop", countsOnly: true }) as any;
    expect(r.counts).toHaveLength(12);
    expect(r.events).toBeUndefined();
    expect(r.latest).toBeUndefined();
  });

  it("reports `latest` as the most recent event in range", () => {
    const r = deviceEvents(cfg, { ...WIN, deviceId: "my-whoop" }) as any;
    expect(r.latest).toEqual({ ts: T0 + 900, deviceId: "my-whoop", family: "whoop", kind: "WRIST_OFF(10)", label: "WRIST_OFF", opcode: 10 });
  });

  it("filters by deviceId, and includes every strap when unfiltered", () => {
    const wide = { from: "2026-06-13T00:00:00Z", to: "2026-06-13T23:59:59Z" };
    const filtered = deviceEvents(cfg, { ...wide, deviceId: "my-whoop" }) as any;
    expect(filtered.events.every((e: any) => e.deviceId === "my-whoop")).toBe(true);
    const all = deviceEvents(cfg, wide) as any;
    expect(all.events.some((e: any) => e.deviceId === "other-strap")).toBe(true);
    expect(all.latest.deviceId).toBe("other-strap"); // the last event in range, whoever reported it
  });

  it("rejects a span wider than 7 days", () => {
    const r = deviceEvents(cfg, { from: "2026-06-01", to: "2026-06-30", deviceId: "my-whoop" }) as any;
    expect(r.error).toBe("span_too_wide");
    expect(r.maxDays).toBe(7);
  });

  it("rejects an unparseable range", () => {
    const r = deviceEvents(cfg, { from: "not-a-date", to: "also-not" }) as any;
    expect(r.error).toBe("bad_range");
  });
});
