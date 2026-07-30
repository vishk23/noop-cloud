import path from "node:path";
import crypto from "node:crypto";

export interface Config {
  port: number;
  dataDir: string;
  mirrorPath: string;
  serverDbPath: string;
  roToken: string;
  rwToken: string;
  /** Secret path segment for the no-auth MCP entry point (POST /mcp/:secret). Unset = route disabled,
   *  every /mcp/* returns 404. The URL IS the credential, so this exists only to let clients that
   *  cannot send an Authorization header (e.g. ChatGPT's "No Auth" connector) reach the read-only MCP. */
  mcpUrlSecret?: string;
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
  /** Free bytes /ingest insists on keeping AFTER staging its second full copy of the mirror. */
  minFreeBytes: number;
  /** A `.staged-*` artifact older than this is a crash corpse and gets swept (see sweepStagedArtifacts). */
  stagedSweepAgeMs: number;

  // --- liters page replication (docs/LITERS_RECEIVE.md) -------------------------------------
  //
  // The receive half of delta sync: the phone pushes LTX files instead of a 766 MB database. OFF by
  // default and deliberately so — deploying this build changes nothing until LITERS_SINK_ENABLED is
  // set, so the deploy that introduces it is not the deploy that switches protocols. /ingest is
  // untouched either way and stays the fallback.
  liters: {
    enabled: boolean;
    /** Bearer token Express presents to the loopback sink. NEVER the phone's token. */
    sinkToken: string;
    /** Where the sink listens. Loopback only: a writable liters mount serves `DELETE /all`. */
    sinkAddr: string;
    /** The `noop-liters-sink` executable. */
    binPath: string;
    /** Pushed LTX files, litestream `file` layout. */
    bucketDir: string;
    /** JSON status the sink republishes after every apply round. */
    statusPath: string;
    /** Largest single LTX body accepted. A snapshot push is the whole database, so this is not small. */
    maxPushBytes: number;
    /** Seconds without a status-file update after which the sink counts as stalled. */
    staleStatusSeconds: number;
  };
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
    mcpUrlSecret: process.env.MCP_URL_SECRET,
    // 1 GiB, applied to BOTH the compressed body and the decompressed database inside it.
    //
    // Since /ingest streams (src/zipstream.ts) this number no longer costs memory — it is a DISK
    // budget. One ingest transiently holds body + staged copy + the live mirror, so on the 3 GB
    // volume a 1 GiB database is ~1.0 + ~0.4 + ~1.0 GB and still clears the 256 MB floor. Anything
    // that does not actually fit on the day is refused up-front with 507 by requireSpaceFor, so this
    // ceiling can be generous without being able to refill the volume.
    //
    // It was 250 MB here and 768 MB in fly.toml — a divergence that made the deployed behaviour
    // unguessable from the source, and 768 MB is exactly what let a 608 MB database through the size
    // check and into the OOM. Keep this value and fly.toml's identical.
    maxIngestBytes: Number(process.env.MAX_INGEST_BYTES ?? 1_073_741_824),
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
    // 256 MB. /ingest writes a SECOND full copy of the mirror (~510 MB today) before renaming it over
    // the first, so the real requirement is `mirror + headroom`, computed per-request in ingestNoopbak.
    // This is only the slack left over — enough that server.sqlite's WAL, a checkpoint, and SQLite's
    // temp files still have somewhere to go on a volume that just absorbed a swap. The 2026-07-26
    // outage was exactly this margin reaching zero: SQLite could not even create the mirror's -shm.
    minFreeBytes: Number(process.env.MIN_FREE_BYTES ?? 268_435_456),
    // 1 hour. ingestNoopbak is synchronous and a ~500 MB stage finishes in seconds, so nothing this
    // old can belong to a live request — but the guard means a sweep can never race a real upload.
    stagedSweepAgeMs: Number(process.env.STAGED_SWEEP_AGE_MS ?? 3_600_000),
    liters: {
      enabled: process.env.LITERS_SINK_ENABLED === "1",
      // Derived, not configured. A second hand-managed secret is a second thing to leak, rotate and
      // get wrong; this one never leaves the machine (Express -> 127.0.0.1) and is reproducible on
      // both sides of the fork/exec from a secret that already exists. HMAC rather than the raw
      // token so that reading a process listing or a core dump of the sink does not hand over the
      // phone's RW credential.
      sinkToken: process.env.LITERS_SINK_TOKEN
        ?? crypto.createHmac("sha256", process.env.RW_TOKEN ?? "").update("liters-sink-v1").digest("hex"),
      sinkAddr: process.env.LITERS_SINK_ADDR ?? "127.0.0.1:9736",
      binPath: process.env.LITERS_SINK_BIN ?? "/app/bin/noop-liters-sink",
      bucketDir: process.env.LITERS_BUCKET_DIR ?? path.join(dataDir, "ltx-bucket"),
      statusPath: process.env.LITERS_STATUS_PATH ?? path.join(dataDir, "liters-sink-status.json"),
      // 1 GiB, matching MAX_INGEST_BYTES for the same reason: a `snapshotting = true` push carries
      // the WHOLE database as one LTX file, so the ceiling on a push is the ceiling on the database,
      // not on a delta. requireSpaceFor is what refuses a body the volume cannot hold today.
      maxPushBytes: Number(process.env.LITERS_MAX_PUSH_BYTES ?? 1_073_741_824),
      staleStatusSeconds: Number(process.env.LITERS_STALE_STATUS_SECONDS ?? 120),
    },
  };
}
