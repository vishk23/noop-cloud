import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import Database from "better-sqlite3";
import { buildMirrorSqlite } from "./fixtures/make-fixture.js";
import { Mirror, sourceFamily } from "../src/mirror.js";

const p = path.join(process.cwd(), "test/.tmp/mirror-read.sqlite");
const HR_ONLY_DEVICE = "strap-raw-only";
const HR_ONLY_DAY = "2026-06-25"; // clear of every DAYS entry in the fixture
const HR_ONLY_TS = Math.floor(new Date(`${HR_ONLY_DAY}T04:00:00Z`).getTime() / 1000);

beforeAll(() => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  buildMirrorSqlite(p);
  // A device that only ever writes raw hrSample rows (no dailyMetric, no sleepSession) — the
  // real-world shape of a strap deviceId whose scored daily rollups land under a separate derived
  // "-noop" deviceId (post-hoc audit fix: sources() used to be dailyMetric-only, so this device
  // was invisible even though it held real data).
  const raw = new Database(p);
  raw.prepare("INSERT INTO hrSample VALUES (?,?,?)").run(HR_ONLY_DEVICE, HR_ONLY_TS, 58);
  raw.close();
});

describe("Mirror", () => {
  it("classifies source families", () => {
    expect(sourceFamily("oura-api")).toBe("oura");
    expect(sourceFamily("apple-health")).toBe("apple");
    expect(sourceFamily("my-whoop")).toBe("whoop");
  });
  it("lists sources with latest day", () => {
    const m = new Mirror(p);
    const s = m.sources();
    expect(s.find((x) => x.deviceId === "oura-api")?.latestDay).toBe("2026-06-13");
    m.close();
  });
  it("sources() surfaces a device that only ever writes hrSample rows (post-hoc audit fix)", () => {
    const m = new Mirror(p);
    const s = m.sources();
    const hrOnly = s.find((x) => x.deviceId === HR_ONLY_DEVICE);
    expect(hrOnly).toBeDefined();
    expect(hrOnly!.tables).toEqual(["hrSample"]);
    expect(hrOnly!.latestDay).toBe(HR_ONLY_DAY);
    // A dailyMetric-only device (like oura-api) still reports its table membership too.
    const oura = s.find((x) => x.deviceId === "oura-api");
    expect(oura!.tables).toContain("dailyMetric");
    expect(oura!.tables).toContain("hrSample");
    m.close();
  });
  it("filters dailyMetrics by source and range", () => {
    const m = new Mirror(p);
    const rows = m.dailyMetrics({ deviceId: "oura-api", from: "2026-06-11", to: "2026-06-12" });
    expect(rows.length).toBe(2);
    expect(rows[0].family).toBe("oura");
    m.close();
  });
  it("reports latest data day across sources", () => {
    const m = new Mirror(p); expect(m.latestDataDay()).toBe("2026-06-13"); m.close();
  });
  it("covers sleep/workout/metricSeries/hrCoverage against the fixture schema", () => {
    const m = new Mirror(p);
    const sleeps = m.sleepSummary({ from: "2026-06-10", to: "2026-06-13" });
    expect(sleeps.length).toBe(8);
    expect(sleeps[0].family).toBeDefined();
    const workouts = m.workoutSummary({ from: "2026-06-10", to: "2026-06-13" });
    expect(workouts.length).toBe(2);
    expect(workouts.map((w) => w.sport).sort()).toEqual(["running", "walking"]);
    const points = m.metricSeries({ deviceId: "oura-api", key: "oura_readiness", from: "2026-06-10", to: "2026-06-13" });
    expect(points.length).toBe(4);
    expect(points[0].value).toBe(78);
    expect(m.hrCoverageDays("oura-api")).toBe(4);
    m.close();
  });
});
