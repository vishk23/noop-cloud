import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http"; import Database from "better-sqlite3";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { createApp } from "../src/server.js";
import { appendJournal } from "../src/staging.js";
import { listAnnotations, annotationSummary } from "../src/tools/annotations.js";
import { computeOverlay } from "../src/edits/overlay.js";
import { sleepSummary } from "../src/tools/query.js";
import { healthSnapshot, dataFreshness } from "../src/tools/core.js";
import { compareSources } from "../src/tools/compare.js";

const dataDir = path.join(process.cwd(), "test/.tmp/tools-annotations");
const cfg = {
  dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"),
  maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"),
  mcpUrlSecret: "s".padEnd(32, "s"), port: 0,
} as any;

// The fixture writes a sleepSession starting 03:00Z on each of 2026-06-10..13, and a dailyMetric row
// per device per day. The 06-13 night is the one used below to exercise the day boundary.
const NIGHT_DAY = "2026-06-13";
const EVENING_BEFORE = "2026-06-12";

function add(editId: string, p: object, rationale = "test") {
  return appendJournal(cfg, { editId, kind: "add_annotation", payloadJSON: JSON.stringify(p), beforeJSON: null, rationale });
}
const ann = (o: object) => ({ tags: ["alcohol"], detail: "drank", source: "user_reported", ...o });

beforeAll(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
  const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), cfg);
});
beforeEach(() => { fs.rmSync(cfg.serverDbPath, { force: true }); fs.rmSync(cfg.serverDbPath + "-wal", { force: true }); fs.rmSync(cfg.serverDbPath + "-shm", { force: true }); });

describe("annotations tool", () => {
  it("returns everything when no range is given, newest last, with the vocabulary", () => {
    add("a1", ann({ day: "2026-06-10", detail: "first" }));
    add("a2", ann({ day: "2026-06-12", tags: ["travel", "late_meal"], detail: "second" }));
    const r = listAnnotations(cfg, {});
    expect(r.total).toBe(2);
    expect(r.matched).toBe(2);
    expect(r.annotations.map((a) => a.detail)).toEqual(["first", "second"]);
    expect(r.vocabulary.inUse).toEqual(["alcohol", "late_meal", "travel"]);
    expect(r.vocabulary.known).toContain("supplement_on");
    // The seq is what undo_edit takes, so it has to come back with the row.
    expect(r.annotations[0].seq).toBe(1);
    expect(r.annotations[0].rationale).toBe("test");
  });

  it("filters by day range, including spans that only partially overlap it", () => {
    add("a1", ann({ day: "2026-06-01", endDay: "2026-06-11" }));   // span reaching into the range
    add("a2", ann({ day: "2026-06-12" }));                          // inside
    add("a3", ann({ day: "2026-06-20" }));                          // after
    const r = listAnnotations(cfg, { from: "2026-06-10", to: "2026-06-13" });
    expect(r.annotations.map((a) => a.editId)).toEqual(["a1", "a2"]);
  });

  it("filters by tag (any-of) and by source", () => {
    add("a1", ann({ day: "2026-06-10", tags: ["alcohol"] }));
    add("a2", ann({ day: "2026-06-11", tags: ["measurement_artifact"], source: "agent_inferred" }));
    expect(listAnnotations(cfg, { tags: ["measurement_artifact"] }).annotations.map((a) => a.editId)).toEqual(["a2"]);
    expect(listAnnotations(cfg, { tags: ["alcohol", "travel"] }).annotations.map((a) => a.editId)).toEqual(["a1"]);
    expect(listAnnotations(cfg, { source: "user_reported" }).annotations.map((a) => a.editId)).toEqual(["a1"]);
  });

  it("limit keeps the MOST RECENT matches and says so", () => {
    for (let i = 0; i < 5; i++) add(`a${i}`, ann({ day: `2026-06-1${i}` }));
    const r = listAnnotations(cfg, { limit: 2 });
    expect(r.annotations.map((a) => a.day)).toEqual(["2026-06-13", "2026-06-14"]);
    expect(r.truncated).toBe(true);
    expect(r.matched).toBe(5);
  });

  it("an empty store answers cleanly rather than erroring", () => {
    const r = listAnnotations(cfg, {});
    expect(r).toMatchObject({ total: 0, matched: 0, annotations: [] });
    expect(r.vocabulary.inUse).toEqual([]);
  });
});

describe("annotations embedded in the biometric tools", () => {
  it("THE POINT: a session starting after midnight carries the prior evening's annotation", () => {
    add("a1", ann({ day: EVENING_BEFORE, detail: "drank and threw up" }));
    const s = sleepSummary(cfg, { from: "2026-06-10", to: "2026-06-13" });
    const night = s.sessions.find((x: any) => x.deviceId === "my-whoop" && x.startIso.startsWith(NIGHT_DAY)) as any;
    expect(night.annotations).toHaveLength(1);
    expect(night.annotations[0]).toMatchObject({ matchedOn: "priorEvening", detail: "drank and threw up" });
  });

  it("a night with no bearing annotation has no `annotations` key at all", () => {
    add("a1", ann({ day: "2026-05-01" }));
    const s = sleepSummary(cfg, { from: "2026-06-10", to: "2026-06-13" });
    expect(s.sessions.every((x: any) => !("annotations" in x))).toBe(true);
  });

  it("the session's LOCAL day is what matches, not its UTC day", async () => {
    // The 06-13 session starts 03:00Z, which is the EVENING of 06-12 in Los Angeles. With the phone's
    // zone known, a 06-12 annotation is sameDay for that night — matching on the UTC day would file
    // it as priorEvening and, at a range edge, could miss it outright.
    const tzDir = path.join(process.cwd(), "test/.tmp/tools-annotations-tz");
    fs.rmSync(tzDir, { recursive: true, force: true }); fs.mkdirSync(tzDir, { recursive: true });
    const tzCfg = { ...cfg, dataDir: tzDir, mirrorPath: path.join(tzDir, "mirror.sqlite"), serverDbPath: path.join(tzDir, "server.sqlite") } as any;
    const z = path.join(tzDir, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), tzCfg);
    const mdb = new Database(tzCfg.mirrorPath);
    mdb.exec("CREATE TABLE phoneTimezone (day TEXT PRIMARY KEY, tzId TEXT NOT NULL)");
    mdb.prepare("INSERT INTO phoneTimezone VALUES (?,?)").run(EVENING_BEFORE, "America/Los_Angeles");
    mdb.close();
    appendJournal(tzCfg, { editId: "tz1", kind: "add_annotation", payloadJSON: JSON.stringify(ann({ day: EVENING_BEFORE })), beforeJSON: null, rationale: null });

    const night = sleepSummary(tzCfg, { from: "2026-06-10", to: "2026-06-13" })
      .sessions.filter((x: any) => x.deviceId === "my-whoop").at(-1) as any;
    expect(night.tzId).toBe("America/Los_Angeles");
    expect(night.annotations[0].matchedOn).toBe("sameDay");
  });

  it("health_snapshot attaches same-day and spanning annotations to the day row", () => {
    add("a1", ann({ day: "2026-06-13", tags: ["illness"], detail: "fever" }));
    add("a2", ann({ day: "2026-06-01", endDay: "2026-06-13", tags: ["supplement_on"], detail: "protocol running" }));
    const r = healthSnapshot(cfg, { days: 2 }) as any;
    const day = r.days.find((d: any) => d.day === "2026-06-13");
    expect(day.annotations.map((a: any) => a.matchedOn).sort()).toEqual(["sameDay", "span"]);
    // The per-family cells are untouched — annotations sit beside them, never inside one.
    expect(day.whoop.recovery).toBeDefined();
  });

  it("compare_sources attaches same-day annotations without disturbing the metric cells", () => {
    add("a1", ann({ day: "2026-06-12", tags: ["measurement_artifact"], source: "agent_inferred", detail: "charging artifact" }));
    const r = compareSources(cfg, { from: "2026-06-10", to: "2026-06-13" }) as any;
    const hit = r.days.find((d: any) => d.day === "2026-06-12");
    expect(hit.annotations[0]).toMatchObject({ source: "agent_inferred", matchedOn: "sameDay" });
    expect(hit.metrics.restingHr.whoop).toBeGreaterThan(0);
    expect(r.days.find((d: any) => d.day === "2026-06-11").annotations).toBeUndefined();
  });

  it("data_freshness advertises the store as a summary, not a payload dump", () => {
    add("a1", ann({ day: "2026-06-10", tags: ["alcohol"] }));
    add("a2", ann({ day: "2026-06-12", endDay: "2026-06-20", tags: ["travel"] }));
    const f = dataFreshness(cfg) as any;
    expect(f.annotations).toEqual({ count: 2, firstDay: "2026-06-10", lastDay: "2026-06-20", tagsInUse: ["alcohol", "travel"] });
    // The standing-context channel is unaffected by the new one.
    expect(f.baselineNotes).toEqual([]);
  });

  it("annotationSummary reports an empty store without inventing days", () => {
    expect(annotationSummary([])).toEqual({ count: 0, tagsInUse: [] });
  });

  it("overlay wiring is live end-to-end: a journalled annotation reaches computeOverlay", () => {
    add("a1", ann({ day: "2026-06-13" }));
    expect(computeOverlay(cfg).annotations).toHaveLength(1);
  });
});

function mcp(port: number, urlPath: string, headers: Record<string, string>, body: object): Promise<any> {
  return new Promise((resolve) => {
    const r = http.request({ port, path: urlPath, method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        const line = d.split("\n").find((l) => l.startsWith("data:")) ?? d;
        resolve(JSON.parse(line.replace(/^data:\s*/, "")));
      });
    });
    r.end(JSON.stringify(body));
  });
}

describe("annotations MCP registration", () => {
  it("is readable on every scope including the no-auth URL-secret route, but writing still needs a token", async () => {
    const app = createApp(cfg); const server = app.listen(0); const port = (server.address() as any).port;
    const pub = await mcp(port, `/mcp/${cfg.mcpUrlSecret}`, {}, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const ro = await mcp(port, "/mcp", { authorization: `Bearer ${cfg.roToken}` }, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    server.close();
    const pubNames = pub.result.tools.map((t: any) => t.name);
    const roNames = ro.result.tools.map((t: any) => t.name);
    expect(pubNames).toContain("annotations");
    // Same precedent as data_freshness/baselineNotes: readable anonymously, never writable.
    expect(pubNames).not.toContain("propose_edit");
    expect(roNames).toContain("annotations");
    expect(roNames).toContain("propose_edit");
  });
});
