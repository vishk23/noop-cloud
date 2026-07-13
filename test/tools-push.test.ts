import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http"; import crypto from "node:crypto";
import { requestSync } from "../src/tools/push.js";
import { upsertDeviceToken } from "../src/push/registry.js";
import { createApp } from "../src/server.js";
import type { SendFn } from "../src/push/apns.js";

const dataDir = path.join(process.cwd(), "test/.tmp/tools-push");
// Each call gets its own server DB, so a token/throttle state registered in one test can't leak
// into another test's device-count or throttle assertions (same reasoning as push-apns.test.ts).
let dbCounter = 0;
function baseCfg(extra: Record<string, unknown> = {}) {
  dbCounter++;
  return { dataDir, mirrorPath: path.join(dataDir, "mirror.sqlite"), serverDbPath: path.join(dataDir, `server-${dbCounter}.sqlite`), maxIngestBytes: 262_144_000, roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0, ...extra } as any;
}
// Real EC P-256 PEM: the "pushes..." test below actually reaches buildProviderJWT (it has a
// registered device and isn't throttled), which calls crypto.createPrivateKey — a placeholder
// string there would fail OpenSSL decoding before the mocked transport is ever invoked.
const { privateKey: TEST_APNS_KEY_P8 } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const APNS_ENV = { apnsKeyP8: TEST_APNS_KEY_P8, apnsKeyId: "KID", appleTeamId: "TEAM", apnsTopic: "com.example.NOOP" };

beforeAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

describe("requestSync (business logic, mirrors dataFreshness/healthSnapshot's direct-call test style)", () => {
  it("reports unconfigured when no APNS env is set", async () => {
    const r = await requestSync(baseCfg());
    expect(r).toEqual({ configured: false, hint: "set APNS_KEY_P8/APNS_KEY_ID/APPLE_TEAM_ID/APNS_TOPIC fly secrets" });
  });

  it("reports unconfigured when only some of the four APNS vars are set", async () => {
    const r = await requestSync(baseCfg({ apnsKeyId: "KID", appleTeamId: "TEAM" })); // missing key + topic
    expect(r).toMatchObject({ configured: false });
  });

  it("reports zero devices when configured but nothing has registered", async () => {
    const r = await requestSync(baseCfg({ ...APNS_ENV, apnsKeyId: "KID-zero" }));
    expect(r).toEqual({ configured: true, devices: 0, hint: "open NOOP once so the phone registers" });
  });

  it("pushes via the injected transport, reports mirrorAgeSeconds, then throttles the immediate next call", async () => {
    const cfg = baseCfg({ ...APNS_ENV, apnsKeyId: "KID-throttle" });
    upsertDeviceToken(cfg, "1".repeat(64), "ios");
    let calls = 0;
    const send: SendFn = async () => { calls++; return { status: 200, body: "" }; };

    const first = await requestSync(cfg, send);
    expect(first).toMatchObject({ pushed: 1, expectFreshWithinSec: 90, hint: "poll data_freshness until mirrorAgeSeconds resets" });
    expect(Object.keys(first)).toContain("mirrorAgeSeconds");
    expect(calls).toBe(1);

    const second: any = await requestSync(cfg, send);
    expect(second.throttled).toBe(true);
    expect(second.retryInSec).toBeGreaterThan(0);
    expect(second.retryInSec).toBeLessThanOrEqual(120);
    expect(calls).toBe(1); // throttled path never reaches the transport
  });
});

describe("request_sync tool wiring (real MCP round-trip)", () => {
  function mcp(port: number, token: string, body: object): Promise<any> {
    return new Promise((resolve) => {
      const payload = JSON.stringify(body);
      const r = http.request({ port, path: "/mcp", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
        let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
          const line = d.split("\n").find((l) => l.startsWith("data:")) ?? d;
          resolve(JSON.parse(line.replace(/^data:\s*/, "")));
        });
      });
      r.end(payload);
    });
  }

  // No APNS_* env set on this cfg, so request_sync short-circuits on the `configured` check before
  // any network code runs — safe to exercise over the real /mcp endpoint without touching real APNs.
  it("is visible to a read-only caller and wired end-to-end (unconfigured path)", async () => {
    const cfg = baseCfg();
    const app = createApp(cfg); const server = app.listen(0); const port = (server.address() as any).port;
    const list = await mcp(port, cfg.roToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const call = await mcp(port, cfg.roToken, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "request_sync", arguments: {} } });
    server.close();
    expect(list.result.tools.map((t: any) => t.name)).toContain("request_sync");
    expect(call.result.structuredContent).toEqual({ configured: false, hint: "set APNS_KEY_P8/APNS_KEY_ID/APPLE_TEAM_ID/APNS_TOPIC fly secrets" });
  });
});
