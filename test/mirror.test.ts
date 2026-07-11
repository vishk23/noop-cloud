import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { buildMirrorSqlite } from "./fixtures/make-fixture.js";
import { Mirror, sourceFamily } from "../src/mirror.js";

const p = path.join(process.cwd(), "test/.tmp/mirror-read.sqlite");
beforeAll(() => { fs.mkdirSync(path.dirname(p), { recursive: true }); buildMirrorSqlite(p); });

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
});
