import zlib from "node:zlib";
import type { Config } from "./config.js";
import { openServerDb } from "./serverdb.js";
import type { ObjectStore } from "./objectstore.js";

export class DeepBufError extends Error {
  constructor(public code: string, msg?: string) { super(msg ?? code); }
}

/** One JSONL line as PuffinDeepBufferLog writes it. Only the fields the manifest needs are modelled. */
interface DeepBufLine {
  ts_ms?: number;
  strap_ts?: number | null;
  size?: number;
  offload?: boolean;
  imu?: unknown;
}

/**
 * Per-chunk manifest facts — everything a coverage/window query needs so the archive is answerable
 * WITHOUT fetching the payload back out of the bucket. This is the whole reason the server parses the
 * chunk at all rather than treating it as opaque bytes: 9 GB/month of hex is unqueryable if the only
 * index is the object key.
 */
export interface ChunkStats {
  lines: number;
  firstTsMs: number | null;
  lastTsMs: number | null;
  firstStrapTs: number | null;
  lastStrapTs: number | null;
  n1244: number;
  n2140: number;
  nOther: number;
  nImu: number;
  nOffload: number;
  badLines: number;
}

/**
 * Parse one decompressed chunk into manifest stats.
 *
 * Tolerant by design: a line that won't parse is COUNTED (`badLines`) and skipped, never thrown on.
 * The payload is already durably stored by the time this matters, and the archive's value is the raw
 * hex — refusing a whole 16 MB chunk because one line is malformed would discard thousands of good
 * buffers to punish one bad one. A non-zero badLines is surfaced through the manifest so the problem
 * is visible rather than silent.
 *
 * strap_ts is the load-bearing key (the unix second the strap itself stamped) and is what coverage
 * queries range over — it is emitted as literal `null` by the capture path when the frame was too
 * short to carry one, so null here is expected, not corrupt.
 */
export function parseChunkStats(raw: Buffer): ChunkStats {
  const s: ChunkStats = {
    lines: 0, firstTsMs: null, lastTsMs: null, firstStrapTs: null, lastStrapTs: null,
    n1244: 0, n2140: 0, nOther: 0, nImu: 0, nOffload: 0, badLines: 0,
  };
  for (const text of raw.toString("utf8").split("\n")) {
    if (!text) continue;
    let line: DeepBufLine;
    try { line = JSON.parse(text); } catch { s.badLines += 1; continue; }
    s.lines += 1;
    if (typeof line.ts_ms === "number") {
      if (s.firstTsMs === null || line.ts_ms < s.firstTsMs) s.firstTsMs = line.ts_ms;
      if (s.lastTsMs === null || line.ts_ms > s.lastTsMs) s.lastTsMs = line.ts_ms;
    }
    if (typeof line.strap_ts === "number") {
      if (s.firstStrapTs === null || line.strap_ts < s.firstStrapTs) s.firstStrapTs = line.strap_ts;
      if (s.lastStrapTs === null || line.strap_ts > s.lastStrapTs) s.lastStrapTs = line.strap_ts;
    }
    // 1244 = the 6-axis 100 Hz IMU buffer (decoded); 2140 = the optical/PPG buffer (layout still
    // undecoded, #423). Counting them separately is what lets a coverage query answer "do I have the
    // optical buffers for that night" — the actual open research question — without a byte scan.
    if (line.size === 1244) s.n1244 += 1;
    else if (line.size === 2140) s.n2140 += 1;
    else s.nOther += 1;
    if (line.imu !== undefined) s.nImu += 1;
    if (line.offload === true) s.nOffload += 1;
  }
  return s;
}

/** Object key for a chunk. Generation + byteStart IS the identity, so the key is a pure function of it. */
export function chunkKey(generation: string, byteStart: number): string {
  // Zero-padded so a plain lexicographic bucket listing is also byte order — the archive stays
  // browsable/reassemblable with nothing but `aws s3 ls`, independent of this server's DB.
  return `deepbuf/v1/${generation}/${String(byteStart).padStart(16, "0")}.jsonl.deflate`;
}

const GENERATION_RE = /^[0-9-]{1,32}-[0-9]{1,20}$/;

/** Validate the phone's chunk headers. Returns the parsed values or throws a typed DeepBufError. */
export function parseChunkHeaders(h: {
  generation?: string; byteStart?: string; byteEnd?: string; compression?: string;
}): { generation: string; byteStart: number; byteEnd: number } {
  // The generation lands in an object key, so it is validated to the exact shape the phone mints
  // (`<epochMs>-<inode>`, see DeepBufferUploadPlan.generationId) rather than merely escaped.
  if (!h.generation || !GENERATION_RE.test(h.generation)) throw new DeepBufError("bad_generation");
  const byteStart = Number(h.byteStart), byteEnd = Number(h.byteEnd);
  if (!Number.isSafeInteger(byteStart) || byteStart < 0) throw new DeepBufError("bad_byte_start");
  if (!Number.isSafeInteger(byteEnd) || byteEnd <= byteStart) throw new DeepBufError("bad_byte_end");
  // The phone announces raw DEFLATE — Apple's Compression `.zlib` emits a headerless stream, which is
  // why this inflates with inflateRaw. Reject anything else loudly rather than guessing at a format.
  if (h.compression !== "deflate-raw") throw new DeepBufError("bad_compression");
  return { generation: h.generation, byteStart, byteEnd };
}

/**
 * Receive one line-aligned, raw-DEFLATE chunk: inflate it, extract manifest stats, put the COMPRESSED
 * bytes in the bucket, and record the row.
 *
 * ORDER MATTERS — bucket first, then DB. If the DB write fails after a successful put, the object is
 * merely orphaned and the phone's retry (its watermark never advanced) re-puts the same key and
 * records the row; the archive is complete and one object was written twice, which is free. The
 * reverse order would let the manifest reference an object that does not exist — a hole that no retry
 * ever heals, because the phone believes that range is done.
 *
 * IDEMPOTENT on `(generation, byteStart)`: that pair is exactly the phone's watermark unit, so an
 * at-least-once client (a 2xx lost in flight, a retried background wake) lands on the same key with
 * the same bytes. The duplicate is reported, not re-stored.
 *
 * The compressed bytes are stored VERBATIM — never re-compressed, never stored inflated. The phone
 * already paid for the deflate, the ratio is the point, and re-encoding server-side would risk the
 * archive's byte fidelity for nothing.
 */
export async function ingestDeepBufferChunk(
  body: Buffer,
  headers: { generation: string; byteStart: number; byteEnd: number },
  cfg: Pick<Config, "serverDbPath" | "maxDeepbufBytes" | "maxDeepbufRawBytes">,
  store: ObjectStore,
  opts: { deviceId?: string | null; phoneTz?: string | null } = {},
): Promise<{ ok: true; objectKey: string; storedBytes: number; rawBytes: number; lines: number; duplicate?: true }> {
  if (body.length === 0) throw new DeepBufError("empty_body");
  if (body.length > cfg.maxDeepbufBytes) throw new DeepBufError("too_large", `body ${body.length} > ${cfg.maxDeepbufBytes}`);

  const { generation, byteStart, byteEnd } = headers;
  const key = chunkKey(generation, byteStart);
  const db = openServerDb(cfg as Pick<Config, "serverDbPath">);
  try {
    const existing = db.prepare("SELECT storedBytes, rawBytes, lines FROM deepBufferChunk WHERE generation=? AND byteStart=?")
      .get(generation, byteStart) as { storedBytes: number; rawBytes: number; lines: number } | undefined;
    if (existing) {
      return { ok: true, objectKey: key, storedBytes: existing.storedBytes, rawBytes: existing.rawBytes, lines: existing.lines, duplicate: true };
    }

    // maxOutputLength is the zip-bomb bound: `body` is attacker-shaped in principle and DEFLATE's
    // ratio is unbounded, so a few KB could otherwise inflate until the machine dies. zlib enforces
    // this during inflation and throws rather than allocating past it.
    let raw: Buffer;
    try {
      raw = zlib.inflateRawSync(body, { maxOutputLength: cfg.maxDeepbufRawBytes });
    } catch (e: any) {
      // ERR_BUFFER_TOO_LARGE is the bomb; anything else is a malformed/mis-declared stream (e.g. a
      // client that sent zlib-wrapped rather than raw DEFLATE) — worth telling apart in the response.
      if (e?.code === "ERR_BUFFER_TOO_LARGE") throw new DeepBufError("too_large", "decompressed past the cap");
      throw new DeepBufError("bad_deflate", String(e?.message ?? e));
    }
    // The phone cuts every chunk at a line boundary, so this is a real integrity check on the wire,
    // not a formality: a mismatch means the bytes are not the range the header claims.
    if (raw.length !== byteEnd - byteStart) {
      throw new DeepBufError("length_mismatch", `inflated ${raw.length} != declared ${byteEnd - byteStart}`);
    }
    const stats = parseChunkStats(raw);

    await store.put(key, body, { generation, byteStart: String(byteStart), byteEnd: String(byteEnd) });

    db.prepare(`INSERT INTO deepBufferChunk
      (generation, byteStart, byteEnd, objectKey, deviceId, storedBytes, rawBytes, lines,
       firstTsMs, lastTsMs, firstStrapTs, lastStrapTs, n1244, n2140, nOther, nImu, nOffload, badLines,
       receivedAt, phoneTz)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      generation, byteStart, byteEnd, key, opts.deviceId ?? null, body.length, raw.length, stats.lines,
      stats.firstTsMs, stats.lastTsMs, stats.firstStrapTs, stats.lastStrapTs,
      stats.n1244, stats.n2140, stats.nOther, stats.nImu, stats.nOffload, stats.badLines,
      Math.floor(Date.now() / 1000), opts.phoneTz ?? null);

    return { ok: true, objectKey: key, storedBytes: body.length, rawBytes: raw.length, lines: stats.lines };
  } finally { db.close(); }
}
