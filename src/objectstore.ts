import fs from "node:fs";
import path from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "./config.js";

/**
 * Bulk blob storage for the deep-buffer archive.
 *
 * WHY NOT THE FLY VOLUME: the strap banks one 1244-B + one 2140-B buffer per second of history, which
 * is ~300 MB/day raw and ~600 MB/day as the hex JSONL the phone actually writes — ~9 GB/month of raw
 * archive if worn continuously. The `noop_data` volume behind DATA_DIR has ~547 MB free and holds the
 * mirror + server DB; a single day of capture would fill it and take the whole server down with it.
 * The volume stays for the MANIFEST (one small row per ~16 MB chunk — ~1100 rows/month, kilobytes) and
 * the bulk bytes go to object storage. That split is the whole point: the index is small, queryable and
 * local; the payload is large, cold and remote.
 *
 * The interface is deliberately the S3 subset R2 also speaks, so the provider is a config change rather
 * than a rewrite (see `S3ObjectStore`).
 */
export interface ObjectStore {
  put(key: string, body: Buffer, meta?: Record<string, string>): Promise<void>;
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<{ bytes: number } | null>;
  /** A time-limited direct-download URL, or null when the backend can't mint one (the FS store). */
  signedUrl(key: string, ttlS: number): Promise<string | null>;
  readonly kind: string;
}

/**
 * S3-protocol store — used for BOTH Cloudflare R2 and real AWS S3, which is why the recommendation
 * carries no lock-in: R2 implements the S3 API, so pointing `S3_ENDPOINT` at
 * `https://<account>.r2.cloudflarestorage.com` (R2) or dropping it entirely (AWS) is the entire
 * difference. `region: "auto"` is R2's convention; AWS ignores it in favour of a real region, which is
 * why the region is configurable too.
 *
 * `forcePathStyle` is required for R2 (it does not do virtual-host-style bucket subdomains).
 */
export class S3ObjectStore implements ObjectStore {
  readonly kind = "s3";
  private client: S3Client;
  constructor(private bucket: string, opts: { endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string }) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}),
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }
  async put(key: string, body: Buffer, meta?: Record<string, string>): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, Metadata: meta }));
  }
  async get(key: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async head(key: string): Promise<{ bytes: number } | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: r.ContentLength ?? 0 };
    } catch { return null; }
  }
  async signedUrl(key: string, ttlS: number): Promise<string | null> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlS });
  }
}

/**
 * Filesystem store — TESTS AND LOCAL DEV ONLY, and reachable only by setting `DEEPBUF_FS_DIR`
 * explicitly.
 *
 * It is deliberately NOT a fallback when the S3 config is absent. A silent fallback is exactly the bug
 * that would matter: an operator who forgets an env var would get a server that looks healthy while
 * quietly writing ~600 MB/day onto a 547 MB volume, and the first symptom would be the mirror failing
 * to ingest because the disk is full. Unconfigured storage returns 503 from `/deepbuf` instead — a
 * loud, immediate, obviously-wrong answer beats a quiet, delayed, catastrophic one.
 */
export class FsObjectStore implements ObjectStore {
  readonly kind = "fs";
  constructor(private root: string) {}
  private p(key: string) {
    // Refuse anything that could escape the root. Keys are server-generated today, but this is the
    // one place a caller-influenced string becomes a filesystem path.
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error("bad_key");
    return full;
  }
  async put(key: string, body: Buffer): Promise<void> {
    const full = this.p(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  async get(key: string): Promise<Buffer> { return fs.readFileSync(this.p(key)); }
  async head(key: string): Promise<{ bytes: number } | null> {
    try { return { bytes: fs.statSync(this.p(key)).size }; } catch { return null; }
  }
  async signedUrl(): Promise<string | null> { return null; }
}

/**
 * The configured store, or null when bulk storage is not set up. Null is a first-class answer, not an
 * error: it lets `/deepbuf` return a clean 503 and the MCP tools report `configured:false` (the same
 * shape `request_sync` already uses for unset APNs), so an unconfigured deploy degrades to "this
 * feature is off" rather than a 500 or a full volume.
 */
export function makeObjectStore(cfg: Config): ObjectStore | null {
  if (cfg.deepbufFsDir) return new FsObjectStore(cfg.deepbufFsDir);
  if (cfg.s3Bucket && cfg.s3AccessKeyId && cfg.s3SecretAccessKey) {
    return new S3ObjectStore(cfg.s3Bucket, {
      endpoint: cfg.s3Endpoint,
      region: cfg.s3Region,
      accessKeyId: cfg.s3AccessKeyId,
      secretAccessKey: cfg.s3SecretAccessKey,
    });
  }
  return null;
}
