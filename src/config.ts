import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  mirrorPath: string;
  serverDbPath: string;
  roToken: string;
  rwToken: string;
  maxIngestBytes: number;
  // Push-triggered on-demand sync (request_sync MCP tool + POST /register-device). All four
  // optional together: unset means the tool responds {configured:false} instead of failing.
  apnsKeyP8?: string;
  apnsKeyId?: string;
  appleTeamId?: string;
  apnsTopic?: string;
  // Deep-buffer bulk object storage (#423). Same all-optional-together convention as APNs above:
  // unset means POST /deepbuf returns 503 and the MCP tools report configured:false — never a
  // fallback onto the Fly volume, which has ~547 MB free against ~600 MB/DAY of archive (see
  // src/objectstore.ts). S3-protocol, so these point at Cloudflare R2 or AWS S3 interchangeably.
  s3Bucket?: string;
  s3Endpoint?: string;
  s3Region: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  /** Tests/local dev ONLY — an explicit opt-in to a filesystem store. Never set in production. */
  deepbufFsDir?: string;
  /** Compressed bytes accepted on one /deepbuf chunk. */
  maxDeepbufBytes: number;
  /** Decompressed ceiling for one chunk — the zip-bomb bound (see ingestDeepBufferChunk). */
  maxDeepbufRawBytes: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length < 32) throw new Error(`${name} must be set (>=32 chars)`);
  return v;
}

export function loadConfig(): Config {
  const dataDir = process.env.DATA_DIR ?? "./data";
  return {
    port: Number(process.env.PORT ?? 8080),
    dataDir,
    mirrorPath: path.join(dataDir, "mirror.sqlite"),
    serverDbPath: path.join(dataDir, "server.sqlite"),
    roToken: required("RO_TOKEN"),
    rwToken: required("RW_TOKEN"),
    maxIngestBytes: Number(process.env.MAX_INGEST_BYTES ?? 262_144_000),
    apnsKeyP8: process.env.APNS_KEY_P8,
    apnsKeyId: process.env.APNS_KEY_ID,
    appleTeamId: process.env.APPLE_TEAM_ID,
    apnsTopic: process.env.APNS_TOPIC,
    // S3_* is the explicit form and always wins. The AWS_*/BUCKET_NAME fallbacks are exactly the
    // names `fly storage create` sets when it provisions a Tigris bucket, so on Fly — where this
    // deploys — that one command is the whole setup, with no secret re-typing and no chance of a
    // transcription error in a key that only fails at runtime, on the first upload, as a 403.
    // Tigris is S3-compatible, so the same S3ObjectStore drives it, R2 and AWS unchanged.
    s3Bucket: process.env.S3_BUCKET ?? process.env.BUCKET_NAME,
    s3Endpoint: process.env.S3_ENDPOINT ?? process.env.AWS_ENDPOINT_URL_S3,
    // "auto" is R2's and Tigris's convention; AWS S3 needs a real region, hence configurable.
    s3Region: process.env.S3_REGION ?? process.env.AWS_REGION ?? "auto",
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID,
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY,
    deepbufFsDir: process.env.DEEPBUF_FS_DIR,
    // 24 MB: the phone caps a chunk at 16 MB RAW and DEFLATE can slightly EXPAND incompressible
    // input, so the compressed body has to be allowed above the raw cap, not below it.
    maxDeepbufBytes: Number(process.env.MAX_DEEPBUF_BYTES ?? 25_165_824),
    // 64 MB decompressed: comfortably above the phone's 16 MB raw chunk, far below anything that
    // could exhaust the 2 GB machine. Enforced by inflateRaw's own maxOutputLength.
    maxDeepbufRawBytes: Number(process.env.MAX_DEEPBUF_RAW_BYTES ?? 67_108_864),
  };
}
