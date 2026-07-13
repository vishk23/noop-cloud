import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { upsertDeviceToken, listDeviceTokens, countDeviceTokens, deleteDeviceToken, getLastPushAt, setLastPushAt } from "../src/push/registry.js";

const dataDir = path.join(process.cwd(), "test/.tmp/push-registry");
const cfg = { serverDbPath: path.join(dataDir, "server.sqlite") } as any;
beforeAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

const TOKEN_A = "a1".repeat(32); // 64 hex chars
const TOKEN_B = "b2".repeat(32);

describe("device token registry", () => {
  it("upsert inserts a new token and returns the running total", () => {
    expect(upsertDeviceToken(cfg, TOKEN_A, "ios")).toBe(1);
    expect(upsertDeviceToken(cfg, TOKEN_B, "ios")).toBe(2);
  });
  it("re-registering the same token refreshes it without growing the count", () => {
    const before = listDeviceTokens(cfg).find((t) => t.token === TOKEN_A)!;
    const count = upsertDeviceToken(cfg, TOKEN_A, "ios");
    expect(count).toBe(2); // still just A and B
    const after = listDeviceTokens(cfg).find((t) => t.token === TOKEN_A)!;
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt); // second-resolution clock, no forced sleep
    expect(after.platform).toBe("ios");
  });
  it("countDeviceTokens matches listDeviceTokens length", () => {
    expect(countDeviceTokens(cfg)).toBe(listDeviceTokens(cfg).length);
    expect(countDeviceTokens(cfg)).toBe(2);
  });
  it("deleteDeviceToken removes exactly the targeted token", () => {
    deleteDeviceToken(cfg, TOKEN_B);
    expect(listDeviceTokens(cfg).map((t) => t.token)).toEqual([TOKEN_A]);
    expect(countDeviceTokens(cfg)).toBe(1);
  });
  it("deleting an unknown token is a harmless no-op", () => {
    expect(() => deleteDeviceToken(cfg, "f".repeat(64))).not.toThrow();
    expect(countDeviceTokens(cfg)).toBe(1);
  });
});

describe("push throttle state (pushState)", () => {
  it("getLastPushAt is null before any push has been recorded", () => {
    expect(getLastPushAt(cfg)).toBeNull();
  });
  it("setLastPushAt persists and getLastPushAt reads it back", () => {
    setLastPushAt(cfg, 1_700_000_000);
    expect(getLastPushAt(cfg)).toBe(1_700_000_000);
  });
  it("setLastPushAt overwrites the single row instead of inserting a second one", () => {
    setLastPushAt(cfg, 1_800_000_000);
    expect(getLastPushAt(cfg)).toBe(1_800_000_000);
  });
});
