import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { createApp } from "../src/server.js";

// Full MCP loop for the post-hoc audit fix: delete_metric_point's key can now name a dailyMetric
// COLUMN (not just a metricSeries key), so a single confirmed-bogus dailyMetric value (the
// motivating real case: restingHr=90 for oura-api on 2025-05-29, neighbors 41/43/48) can finally
// be blanked. Mirrors tools-granular-e2e.test.ts's propose(ro) -> confirm(rw) -> read -> undo(rw)
// -> reverts shape.
const dataDir = path.join(process.cwd(), "test/.tmp/edits-metric-column");
function cfg() { return { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0 } as any; }

function mcp(port: number, token: string, id: number, name: string, args: object): Promise<any> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const r = http.request({ port, path: "/mcp", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        const line = d.split("\n").find((l) => l.startsWith("data:")) ?? d;
        resolve(JSON.parse(line.replace(/^data:\s*/, "")).result.structuredContent);
      });
    });
    r.end(payload);
  });
}

let port = 0; let server: any;
beforeAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
  const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); ingestNoopbak(fs.readFileSync(z), cfg());
  const app = createApp(cfg()); server = app.listen(0); port = (server.address() as any).port;
});

describe("delete_metric_point on a dailyMetric column, full MCP loop", () => {
  it("propose(ro) → confirm(rw) → hidden on compare_sources AND health_snapshot → undo(rw) → restored", async () => {
    // Fixture: oura-api restingHr on 2026-06-13 is 53 (make-fixture.ts).
    const p = await mcp(port, cfg().roToken, 1, "propose_edit", { kind: "delete_metric_point", payload: { deviceId: "oura-api", day: "2026-06-13", key: "restingHr" }, rationale: "bogus spike, neighbors read 41/43/48" });
    expect(p.status).toBe("pending");
    expect(p.diff).toContain("restingHr");
    expect(p.diff).toContain("53");

    const c = await mcp(port, cfg().rwToken, 2, "confirm_edit", { id: p.id });
    expect(c.applied).toBe(true);

    const cmp1 = await mcp(port, cfg().roToken, 3, "compare_sources", { from: "2026-06-13", to: "2026-06-13", metrics: ["restingHr"] });
    expect(cmp1.days[0].metrics.restingHr.oura).toBeUndefined();
    expect(cmp1.days[0].metrics.restingHr.whoop).toBe(51); // unaffected

    const snap1 = await mcp(port, cfg().roToken, 4, "health_snapshot", { days: 1 });
    expect(snap1.days[snap1.days.length - 1].oura.restingHr).toBeUndefined();

    const u = await mcp(port, cfg().rwToken, 5, "undo_edit", { seq: c.seq });
    expect(u.undoneSeq).toBe(c.seq);

    const cmp2 = await mcp(port, cfg().roToken, 6, "compare_sources", { from: "2026-06-13", to: "2026-06-13", metrics: ["restingHr"] });
    expect(cmp2.days[0].metrics.restingHr.oura).toBe(53);

    const snap2 = await mcp(port, cfg().roToken, 7, "health_snapshot", { days: 1 });
    expect(snap2.days[snap2.days.length - 1].oura.restingHr).toBe(53);
  });

  it("propose_edit on a dailyMetric column with no value returns target_not_found", async () => {
    // apple-health avgHrv is null for every day in the fixture.
    const p = await mcp(port, cfg().roToken, 8, "propose_edit", { kind: "delete_metric_point", payload: { deviceId: "apple-health", day: "2026-06-13", key: "avgHrv" }, rationale: "test missing target" });
    expect(p.error).toBe("target_not_found");
  });
});
