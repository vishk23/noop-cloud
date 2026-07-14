import crypto from "node:crypto";
import http2 from "node:http2";
import type { Config } from "../config.js";
import { listDeviceTokens, deleteDeviceToken } from "./registry.js";

// Sandbox by default: the personal-fork iOS build is dev-signed (`aps-environment: development`),
// so its tokens live in APNs sandbox — pushing them at the production host returns BadDeviceToken
// (and this sender PRUNES on BadDeviceToken, which would silently unregister the phone forever).
// Set APNS_ENV=production only when the app ships with a production push entitlement.
const APNS_HOST = process.env.APNS_ENV === "production"
  ? "https://api.push.apple.com"
  : "https://api.sandbox.push.apple.com";
const JWT_TTL_S = 45 * 60; // Apple allows provider JWTs up to ~60min old; refresh at 45 to stay well inside.

type ApnsConfig = Pick<Config, "apnsKeyP8" | "apnsKeyId" | "appleTeamId" | "apnsTopic">;

export function isApnsConfigured(cfg: Partial<ApnsConfig>): boolean {
  return !!(cfg.apnsKeyP8 && cfg.apnsKeyId && cfg.appleTeamId && cfg.apnsTopic);
}

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input)).toString("base64url");
}

// node:crypto's sign() emits an ECDSA signature as a DER SEQUENCE of two INTEGERs (r, s). JOSE
// (RFC 7518 §3.4 — what APNs' ES256 provider-JWT auth expects) wants the raw concatenation of r
// and s, each left-padded to 32 bytes. Standard DER->JOSE transform; P-256 sigs are always small
// enough that the outer SEQUENCE length is single-byte (short-form), so no long-form-length case.
function derToJose(der: Buffer, paramBytes = 32): Buffer {
  let offset = 2; // skip SEQUENCE tag (0x30) + short-form length byte
  const readInt = (): Buffer => {
    offset++; // skip INTEGER tag (0x02)
    const len = der[offset++];
    let bytes = der.subarray(offset, offset + len);
    offset += len;
    while (bytes.length > paramBytes && bytes[0] === 0) bytes = bytes.subarray(1); // strip DER sign-padding
    if (bytes.length < paramBytes) bytes = Buffer.concat([Buffer.alloc(paramBytes - bytes.length, 0), bytes]);
    return Buffer.from(bytes);
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

let jwtCache: { cacheKey: string; token: string; iat: number } | null = null;

function buildProviderJWT(cfg: ApnsConfig): string {
  const cacheKey = `${cfg.apnsKeyId}:${cfg.appleTeamId}`;
  const now = Math.floor(Date.now() / 1000);
  if (jwtCache && jwtCache.cacheKey === cacheKey && now - jwtCache.iat < JWT_TTL_S) return jwtCache.token;

  const header = { alg: "ES256", kid: cfg.apnsKeyId };
  const claims = { iss: cfg.appleTeamId, iat: now };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const pem = (cfg.apnsKeyP8 ?? "").replace(/\\n/g, "\n"); // env vars carry the PEM with literal backslash-n
  const key = crypto.createPrivateKey(pem);
  const der = crypto.sign("sha256", Buffer.from(signingInput), key);
  const token = `${signingInput}.${base64url(derToJose(der))}`;
  jwtCache = { cacheKey, token, iat: now };
  return token;
}

export interface ApnsResponse { status: number; body: string; }
export type SendFn = (deviceToken: string, headers: Record<string, string>, payload: string) => Promise<ApnsResponse>;

function http2Send(deviceToken: string, headers: Record<string, string>, payload: string): Promise<ApnsResponse> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(APNS_HOST);
    client.on("error", reject);
    const req = client.request({ ":method": "POST", ":path": `/3/device/${deviceToken}`, ...headers });
    let status = 0;
    let body = "";
    req.on("response", (hdrs) => { status = Number(hdrs[":status"]); });
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => { client.close(); resolve({ status, body }); });
    req.on("error", (err) => { client.close(); reject(err); });
    req.end(payload);
  });
}

export interface SendResult { pushed: number; pruned: number; }

// The visible banner every request_sync push carries. A silent (content-available-only) background
// push CANNOT be delivered reliably — iOS budget-throttles apns-priority:5 background pushes and drops
// them entirely under Low Power Mode or with Background App Refresh off, so a second request_sync
// minutes after a first routinely never woke the app at all. An `alert` push at apns-priority:10 is
// delivered promptly and reliably, AND (because content-available:1 rides along) still wakes the app
// in the background to run its upload — so "visible" and "reliable" are the same single change here.
const PUSH_ALERT = { title: "NOOP", body: "Syncing your latest data…" };

/**
 * Send a VISIBLE (alert + content-available) push to every registered device token. `send` is an
 * injectable seam (defaults to the real HTTP/2 transport) so tests never touch real APNs.
 * Tokens Apple reports as dead (410, or 400 with reason "BadDeviceToken") are pruned from the
 * registry so future pushes stop targeting them.
 */
export async function sendSyncPush(cfg: ApnsConfig & Pick<Config, "serverDbPath">, send: SendFn = http2Send): Promise<SendResult> {
  const tokens = listDeviceTokens(cfg);
  if (tokens.length === 0) return { pushed: 0, pruned: 0 };
  const jwt = buildProviderJWT(cfg);
  const headers = {
    authorization: `bearer ${jwt}`,
    // alert (not background) + priority 10: the ONLY combination iOS delivers promptly and reliably.
    // content-available rides along so a backgrounded app still wakes to upload without a user tap.
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-topic": cfg.apnsTopic!,
    "content-type": "application/json",
  };
  // `purpose` is a custom top-level key (outside `aps`, per APNs) the app reads from userInfo to tell
  // a TAPPED cloud-sync alert apart from its own local notifications (battery/illness/smart-alarm), so
  // only a tap on THIS push kicks an upload.
  const payload = JSON.stringify({ aps: { alert: PUSH_ALERT, "content-available": 1 }, purpose: "cloudsync" });
  let pushed = 0;
  let pruned = 0;
  for (const t of tokens) {
    try {
      const res = await send(t.token, headers, payload);
      if (res.status === 200) { pushed++; continue; }
      let reason: string | undefined;
      try { reason = JSON.parse(res.body)?.reason; } catch { /* non-JSON body */ }
      if (res.status === 410 || reason === "BadDeviceToken") { deleteDeviceToken(cfg, t.token); pruned++; continue; }
      console.error("apns send rejected", t.token.slice(0, 8), res.status, reason ?? res.body);
    } catch (e) {
      console.error("apns send failed", t.token.slice(0, 8), e instanceof Error ? e.message : e);
    }
  }
  return { pushed, pruned };
}
