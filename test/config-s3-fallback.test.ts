import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

/**
 * Pins the S3_* -> AWS_* / BUCKET_NAME fallback that lets `fly storage create` be the whole setup.
 *
 * Worth pinning rather than eyeballing: a fallback chain fails SILENTLY and LATE. Get the precedence
 * backwards and a deploy that sets both reads the wrong bucket; typo a fallback name and the store
 * degrades to null, /deepbuf returns 503, and the phone's watermark quietly stops advancing — which
 * looks exactly like "not configured yet" rather than a bug.
 */
const S3_KEYS = [
  "S3_BUCKET", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
  "BUCKET_NAME", "AWS_ENDPOINT_URL_S3", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
] as const;

describe("S3 config: Tigris/fly fallback", () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const k of S3_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    // loadConfig()'s required() gate is unrelated to what's under test.
    process.env.RO_TOKEN ??= "x".repeat(32);
    process.env.RW_TOKEN ??= "y".repeat(32);
  });

  afterEach(() => {
    for (const k of S3_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
    }
  });

  it("reads the AWS_*/BUCKET_NAME names `fly storage create` sets, with no S3_* at all", () => {
    process.env.BUCKET_NAME = "noop-deepbuf";
    process.env.AWS_ENDPOINT_URL_S3 = "https://fly.storage.tigris.dev";
    process.env.AWS_ACCESS_KEY_ID = "tid_example";
    process.env.AWS_SECRET_ACCESS_KEY = "tsec_example";

    const c = loadConfig();
    expect(c.s3Bucket).toBe("noop-deepbuf");
    expect(c.s3Endpoint).toBe("https://fly.storage.tigris.dev");
    expect(c.s3AccessKeyId).toBe("tid_example");
    expect(c.s3SecretAccessKey).toBe("tsec_example");
  });

  it("S3_* wins when both are set — the explicit form must not be shadowed by an inherited AWS_*", () => {
    process.env.S3_BUCKET = "explicit";
    process.env.BUCKET_NAME = "inherited";
    process.env.S3_ACCESS_KEY_ID = "explicit-key";
    process.env.AWS_ACCESS_KEY_ID = "inherited-key";

    const c = loadConfig();
    expect(c.s3Bucket).toBe("explicit");
    expect(c.s3AccessKeyId).toBe("explicit-key");
  });

  it("region falls back S3_REGION -> AWS_REGION -> 'auto'", () => {
    expect(loadConfig().s3Region).toBe("auto");
    process.env.AWS_REGION = "us-east-1";
    expect(loadConfig().s3Region).toBe("us-east-1");
    process.env.S3_REGION = "auto";
    expect(loadConfig().s3Region).toBe("auto");
  });

  it("stays unconfigured when nothing is set — null store, not a half-configured one", () => {
    const c = loadConfig();
    expect(c.s3Bucket).toBeUndefined();
    expect(c.s3AccessKeyId).toBeUndefined();
    expect(c.s3SecretAccessKey).toBeUndefined();
  });
});
