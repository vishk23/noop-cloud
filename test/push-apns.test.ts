import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import { isApnsConfigured, sendSyncPush } from "../src/push/apns.js";
import type { SendFn } from "../src/push/apns.js";
import { upsertDeviceToken, listDeviceTokens } from "../src/push/registry.js";

const dataDir = path.join(process.cwd(), "test/.tmp/push-apns");
beforeAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

// Real EC P-256 keypair generated once for the whole file — same shape as an Apple .p8 auth key.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}) as unknown as { privateKey: string; publicKey: string };

// Each call gets its own server DB (so registered tokens never leak across tests) and a distinct
// apnsKeyId (so the module-level JWT cache, keyed on `${kid}:${iss}`, stays isolated too) —
// without needing to export a reset hook for either.
let keyCounter = 0;
function baseCfg(overrides: Partial<Record<"apnsKeyP8" | "apnsKeyId" | "appleTeamId" | "apnsTopic", string>> = {}) {
  keyCounter++;
  return {
    serverDbPath: path.join(dataDir, `server-${keyCounter}.sqlite`),
    apnsKeyP8: privateKey,
    apnsKeyId: `TESTKEY${keyCounter}`,
    appleTeamId: `TESTTEAM${keyCounter}`,
    apnsTopic: "com.example.NOOP",
    ...overrides,
  };
}

function decodeJwt(jwt: string) {
  const [h, c, s] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(c, "base64url").toString("utf8")),
    signingInput: `${h}.${c}`,
    signature: Buffer.from(s, "base64url"),
  };
}

describe("isApnsConfigured", () => {
  it("false when unset, or when only some of the four are set", () => {
    expect(isApnsConfigured({})).toBe(false);
    expect(isApnsConfigured({ apnsKeyP8: "x", apnsKeyId: "y", appleTeamId: "z" })).toBe(false); // missing apnsTopic
  });
  it("true when all four are set", () => {
    expect(isApnsConfigured(baseCfg())).toBe(true);
  });
});

describe("sendSyncPush", () => {
  it("short-circuits with no transport calls when there are no registered tokens", async () => {
    const cfg = baseCfg();
    let calls = 0;
    const send: SendFn = async () => { calls++; return { status: 200, body: "" }; };
    expect(await sendSyncPush(cfg, send)).toEqual({ pushed: 0, pruned: 0 });
    expect(calls).toBe(0);
  });

  it("mocked happy path: pushes every token with a well-formed, self-verifying ES256 JWT", async () => {
    const cfg = baseCfg();
    const tokenA = "a".repeat(64), tokenB = "b".repeat(64);
    upsertDeviceToken(cfg, tokenA, "ios");
    upsertDeviceToken(cfg, tokenB, "ios");

    const calls: { deviceToken: string; headers: Record<string, string>; payload: string }[] = [];
    const send: SendFn = async (deviceToken, headers, payload) => {
      calls.push({ deviceToken, headers, payload });
      return { status: 200, body: "" };
    };
    const result = await sendSyncPush(cfg, send);
    expect(result).toEqual({ pushed: 2, pruned: 0 });
    expect(calls.map((c) => c.deviceToken).sort()).toEqual([tokenA, tokenB].sort());

    for (const c of calls) {
      // Visible + wake: an alert dict (so iOS displays a banner) AND content-available:1 (so a
      // backgrounded app still wakes to upload without a user tap), sent as an alert push at
      // priority 10 — the only combination iOS delivers promptly and reliably.
      const body = JSON.parse(c.payload);
      expect(body.aps.alert).toEqual({ title: "NOOP", body: "Syncing your latest data…" });
      expect(body.aps["content-available"]).toBe(1);
      expect(body.purpose).toBe("cloudsync");
      expect(c.headers["apns-push-type"]).toBe("alert");
      expect(c.headers["apns-priority"]).toBe("10");
      expect(c.headers["apns-topic"]).toBe(cfg.apnsTopic);
      expect(c.headers.authorization).toMatch(/^bearer /);
    }
    // Both recipients share one signing pass per sendSyncPush call.
    expect(calls[1].headers.authorization).toBe(calls[0].headers.authorization);

    // JWT shape: header alg/kid, claims iss/iat.
    const jwt = calls[0].headers.authorization.replace(/^bearer /, "");
    const { header, claims, signingInput, signature } = decodeJwt(jwt);
    expect(header).toEqual({ alg: "ES256", kid: cfg.apnsKeyId });
    expect(claims.iss).toBe(cfg.appleTeamId);
    expect(Math.abs(Math.floor(Date.now() / 1000) - claims.iat)).toBeLessThan(5);

    // Signature integrity: 64 raw bytes (r||s, 32 each) that verify against the matching public
    // key using dsaEncoding:'ieee-p1363' (JOSE's raw format) — this is the strongest check that
    // the manual DER->JOSE conversion in apns.ts is correct, no re-encoding back to DER needed.
    expect(signature.length).toBe(64);
    const ok = crypto.verify("sha256", Buffer.from(signingInput), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
    expect(ok).toBe(true);
  });

  it("caches the provider JWT across separate calls and rotates it after ~45 minutes", async () => {
    const cfg = baseCfg();
    upsertDeviceToken(cfg, "9".repeat(64), "ios");
    const seen: string[] = [];
    const send: SendFn = async (_t, headers) => { seen.push(headers.authorization); return { status: 200, body: "" }; };

    await sendSyncPush(cfg, send);
    await sendSyncPush(cfg, send);
    expect(seen[1]).toBe(seen[0]); // reused, not re-signed

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 46 * 60 * 1000);
      await sendSyncPush(cfg, send);
    } finally {
      vi.useRealTimers();
    }
    expect(seen[2]).not.toBe(seen[0]); // cache expired, freshly signed
  });

  it("prunes a token on 410 Gone and leaves other tokens registered", async () => {
    const cfg = baseCfg();
    const dead = "c".repeat(64), alive = "d".repeat(64);
    upsertDeviceToken(cfg, dead, "ios");
    upsertDeviceToken(cfg, alive, "ios");
    const send: SendFn = async (deviceToken) =>
      deviceToken === dead ? { status: 410, body: JSON.stringify({ reason: "Unregistered", timestamp: 0 }) } : { status: 200, body: "" };
    const result = await sendSyncPush(cfg, send);
    expect(result).toEqual({ pushed: 1, pruned: 1 });
    expect(listDeviceTokens(cfg).map((t) => t.token)).toEqual([alive]);
  });

  it("prunes a token on 400 BadDeviceToken", async () => {
    const cfg = baseCfg();
    const dead = "e".repeat(64);
    upsertDeviceToken(cfg, dead, "ios");
    const send: SendFn = async () => ({ status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) });
    const result = await sendSyncPush(cfg, send);
    expect(result).toEqual({ pushed: 0, pruned: 1 });
    expect(listDeviceTokens(cfg).map((t) => t.token)).not.toContain(dead);
  });

  it("does not prune on unrelated errors — a transient 5xx leaves the token registered", async () => {
    const cfg = baseCfg();
    const flaky = "f0".repeat(32);
    upsertDeviceToken(cfg, flaky, "ios");
    const send: SendFn = async () => ({ status: 500, body: JSON.stringify({ reason: "InternalServerError" }) });
    const result = await sendSyncPush(cfg, send);
    expect(result).toEqual({ pushed: 0, pruned: 0 });
    expect(listDeviceTokens(cfg).map((t) => t.token)).toContain(flaky);
  });

  it("a rejected send for one token doesn't stop delivery to the others", async () => {
    const cfg = baseCfg();
    const bad = "11".repeat(32), good = "22".repeat(32);
    upsertDeviceToken(cfg, bad, "ios");
    upsertDeviceToken(cfg, good, "ios");
    const send: SendFn = async (deviceToken) => {
      if (deviceToken === bad) throw new Error("network blip");
      return { status: 200, body: "" };
    };
    expect(await sendSyncPush(cfg, send)).toEqual({ pushed: 1, pruned: 0 });
  });
});
