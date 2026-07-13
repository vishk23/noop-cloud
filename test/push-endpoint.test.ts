import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import { createApp } from "../src/server.js";
import { countDeviceTokens } from "../src/push/registry.js";

const dataDir = path.join(process.cwd(), "test/.tmp/push-endpoint");
function cfg() { return { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, "server.sqlite"), maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0 } as any; }

function post(port: number, token: string | undefined, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const r = http.request({ port, path: "/register-device", method: "POST", headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode!, json: d ? JSON.parse(d) : null }));
    });
    r.end(payload);
  });
}

beforeAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

const TOKEN_A = "a1".repeat(32); // 64 hex chars

describe("POST /register-device", () => {
  it("requires rw (no header -> 401, ro token -> 401)", async () => {
    const app = createApp(cfg()); const s = app.listen(0); const port = (s.address() as any).port;
    expect((await post(port, undefined, { token: TOKEN_A, platform: "ios" })).status).toBe(401);
    expect((await post(port, cfg().roToken, { token: TOKEN_A, platform: "ios" })).status).toBe(401);
    s.close();
  });

  it("registers a valid token and returns the running count", async () => {
    const app = createApp(cfg()); const s = app.listen(0); const port = (s.address() as any).port;
    const r = await post(port, cfg().rwToken, { token: TOKEN_A, platform: "ios" });
    s.close();
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ registered: true, count: 1 });
  });

  it("re-registering the same token is idempotent (count doesn't grow)", async () => {
    const app = createApp(cfg()); const s = app.listen(0); const port = (s.address() as any).port;
    const r = await post(port, cfg().rwToken, { token: TOKEN_A, platform: "ios" });
    s.close();
    expect(r.json).toEqual({ registered: true, count: 1 });
  });

  it("a second distinct token increments the count", async () => {
    const app = createApp(cfg()); const s = app.listen(0); const port = (s.address() as any).port;
    const r = await post(port, cfg().rwToken, { token: "b2".repeat(32), platform: "ios" });
    s.close();
    expect(r.json).toEqual({ registered: true, count: 2 });
    expect(countDeviceTokens(cfg())).toBe(2);
  });

  it("400 bad_token on a too-short or non-hex token", async () => {
    const app = createApp(cfg()); const s = app.listen(0); const port = (s.address() as any).port;
    const short = await post(port, cfg().rwToken, { token: "abc123", platform: "ios" });
    const nonHex = await post(port, cfg().rwToken, { token: "z".repeat(64), platform: "ios" });
    const missing = await post(port, cfg().rwToken, { platform: "ios" });
    s.close();
    for (const r of [short, nonHex, missing]) { expect(r.status).toBe(400); expect(r.json).toEqual({ error: "bad_token" }); }
  });

  it("400 bad_platform on a non-ios platform", async () => {
    const app = createApp(cfg()); const s = app.listen(0); const port = (s.address() as any).port;
    const r = await post(port, cfg().rwToken, { token: "c3".repeat(32), platform: "android" });
    s.close();
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "bad_platform" });
  });
});
