import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { buildNoopbak } from "./fixtures/make-fixture.js"; import { ingestNoopbak } from "../src/ingest.js";
import { search, fetch as fetchDay } from "../src/tools/search-fetch.js";

const dataDir = path.join(process.cwd(), "test/.tmp/tools-search");
const cfg = { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;
beforeAll(async () => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); const z = path.join(dataDir, "b.noopbak"); buildNoopbak(z); await ingestNoopbak(fs.readFileSync(z), cfg); });

describe("search/fetch", () => {
  it("search returns day results with id/title/url", () => {
    const r = search(cfg, { query: "2026-06-12" });
    expect(r.results[0].id).toBe("day:2026-06-12");
    expect(r.results[0]).toHaveProperty("title");
    expect(r.results[0]).toHaveProperty("url");
  });
  it("fetch returns a text digest for a day", () => {
    const r = fetchDay(cfg, { id: "day:2026-06-13" });
    expect(r.id).toBe("day:2026-06-13");
    expect(r.text).toMatch(/resting/i);
    expect(r.text.length).toBeGreaterThan(20);
  });
  it("search and fetch return not-ingested responses before first ingest", () => {
    const emptyDir = path.join(process.cwd(), "test/.tmp/tools-search-empty");
    fs.rmSync(emptyDir, { recursive: true, force: true });
    fs.mkdirSync(emptyDir, { recursive: true });
    const emptyCfg = { dataDir: emptyDir, mirrorPath: path.join(emptyDir, "mirror.sqlite"), serverDbPath: path.join(emptyDir, "server.sqlite"), maxIngestBytes: 262_144_000 } as any;

    const searchResult = search(emptyCfg, { query: "2026-06-12" });
    expect(searchResult.results).toEqual([]);
    expect(searchResult.notIngested).toBe(true);

    const fetchResult = fetchDay(emptyCfg, { id: "day:2026-06-12" });
    expect(fetchResult.id).toBe("day:2026-06-12");
    expect(fetchResult.title).toBe("No data");
    expect(fetchResult.text).toBe("No data ingested yet.");
    expect(fetchResult.url).toBe("noop-cloud://empty");
    expect(fetchResult.metadata.notIngested).toBe(true);
  });
});
