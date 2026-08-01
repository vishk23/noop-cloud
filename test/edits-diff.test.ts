import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { payloadSchema, EDIT_KINDS } from "../src/edits/kinds.js";
import { captureBefore, renderDiff, EditTargetError } from "../src/edits/diff.js";

const dataDir = path.join(process.cwd(), "test/.tmp/edits-diff");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
const RUN_TS = Math.floor(new Date("2026-06-12T18:00:00Z").getTime() / 1000); // fixture running workout

beforeAll(async () => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), cfg); });

describe("edit kinds", () => {
  it("validates payloads per kind", () => {
    expect(payloadSchema("delete_workout").safeParse({ deviceId: "my-whoop", startTs: RUN_TS, sport: "running" }).success).toBe(true);
    expect(payloadSchema("adjust_sleep_bounds").safeParse({ deviceId: "my-whoop", startTs: 1 }).success).toBe(false); // needs a new bound
    expect(payloadSchema("add_workout").safeParse({ startTs: 1, endTs: 2, sport: "yoga", deviceId: "my-whoop" }).success).toBe(false); // deviceId not accepted
    expect(EDIT_KINDS.length).toBe(9); // + add_annotation (docs/ANNOTATIONS_DESIGN.md)
  });
  it("captureBefore snapshots the real row and errors on a missing target", () => {
    const before = captureBefore(cfg, "delete_workout", { deviceId: "my-whoop", startTs: RUN_TS, sport: "running" }) as any;
    expect(before.sport).toBe("running");
    expect(() => captureBefore(cfg, "delete_workout", { deviceId: "my-whoop", startTs: 1, sport: "nope" })).toThrow(EditTargetError);
  });
  it("renderDiff is human-readable and mentions old and new values", () => {
    const before = captureBefore(cfg, "adjust_sleep_bounds", { deviceId: "my-whoop", startTs: Math.floor(new Date("2026-06-13T03:00:00Z").getTime() / 1000), newEndTs: Math.floor(new Date("2026-06-13T06:00:00Z").getTime() / 1000) });
    const d = renderDiff("adjust_sleep_bounds", { deviceId: "my-whoop", startTs: Math.floor(new Date("2026-06-13T03:00:00Z").getTime() / 1000), newEndTs: Math.floor(new Date("2026-06-13T06:00:00Z").getTime() / 1000) }, before);
    expect(d).toContain("06:00");
    expect(d.toLowerCase()).toContain("end");
  });

  // delete_metric_point's key now also names a dailyMetric column (post-hoc audit fix): these
  // three cases pin captureBefore/renderDiff's branching between the new dailyMetric-column path
  // and the original metricSeries-key path.
  it("captureBefore resolves delete_metric_point against a dailyMetric column when the key is allowlisted", () => {
    // oura-api restingHr on 2026-06-13 is 53 in the fixture (make-fixture.ts).
    const before = captureBefore(cfg, "delete_metric_point", { deviceId: "oura-api", day: "2026-06-13", key: "restingHr" }) as any;
    expect(before.value).toBe(53);
    expect(before.source).toBe("dailyMetric");
    const d = renderDiff("delete_metric_point", { deviceId: "oura-api", day: "2026-06-13", key: "restingHr" }, before);
    expect(d).toContain("dailyMetric column");
    expect(d).toContain("53");
  });
  it("captureBefore still resolves delete_metric_point against metricSeries for a non-column key", () => {
    const before = captureBefore(cfg, "delete_metric_point", { deviceId: "oura-api", day: "2026-06-13", key: "oura_readiness" }) as any;
    expect(before.value).toBe(78);
    expect(before.source).toBe("metricSeries");
    const d = renderDiff("delete_metric_point", { deviceId: "oura-api", day: "2026-06-13", key: "oura_readiness" }, before);
    expect(d).toContain("metricSeries key");
  });
  it("captureBefore errors on a dailyMetric column delete with no value at that row", () => {
    // apple-health avgHrv is null for every day in the fixture.
    expect(() => captureBefore(cfg, "delete_metric_point", { deviceId: "apple-health", day: "2026-06-13", key: "avgHrv" })).toThrow(EditTargetError);
  });
});
