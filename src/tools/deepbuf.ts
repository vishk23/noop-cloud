import zlib from "node:zlib";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { openServerDb } from "../serverdb.js";
import { makeObjectStore, type ObjectStore } from "../objectstore.js";

const asTool = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> });
const toTs = (s: string, endOfDay = false) => /^\d{4}-\d{2}-\d{2}$/.test(s)
  ? Math.floor(new Date(`${s}T${endOfDay ? "23:59:59" : "00:00:00"}Z`).getTime() / 1000)
  : Math.floor(new Date(s).getTime() / 1000);
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** A gap longer than this ENDS a capture session (default). Same reasoning as imu_coverage's. */
const DEFAULT_GAP_S = 60;
const COVERAGE_MAX_SPAN_S = 366 * 86_400;

interface ChunkRow {
  generation: string; byteStart: number; byteEnd: number; objectKey: string;
  storedBytes: number; rawBytes: number; lines: number;
  firstTsMs: number | null; lastTsMs: number | null;
  firstStrapTs: number | null; lastStrapTs: number | null;
  n1244: number; n2140: number; nOther: number; nImu: number; badLines: number;
  receivedAt: number;
}

/**
 * deep_buffer_coverage — WHERE the raw WHOOP 5/MG deep buffers exist in the archive, and how much of
 * them there is. The availability question, answered from the MANIFEST alone: no object is fetched, so
 * this stays cheap no matter how many GB the archive holds.
 *
 * Modelled on imu_coverage (contiguous sessions, not per-day buckets — a capture run is the natural
 * unit of "did it work", and sessions are timezone-independent so an overnight is never split at a
 * meaningless UTC boundary). It answers a DIFFERENT question though: imu_coverage reports the DECODED
 * per-second imuActivity rows that reached the mirror, this reports the RAW buffers banked in object
 * storage — including the 2140-B optical buffers, which are still undecoded (#423) and therefore exist
 * nowhere else. A range can easily have one and not the other.
 *
 * Sessions are derived from CHUNK strap_ts extents, not from individual buffers: a chunk is ~16 MB of
 * log and the manifest stores only its first/last strap_ts, so a gap INSIDE a chunk is invisible here.
 * That is a deliberate resolution limit, reported as such rather than papered over — `deep_buffer_window`
 * reads the buffers themselves when per-second truth is needed.
 */
export function deepBufferCoverage(cfg: Config, args: { from?: string; to?: string; gapSeconds?: number }) {
  const store = makeObjectStore(cfg);
  const db = openServerDb(cfg);
  try {
    const total = db.prepare("SELECT COUNT(*) n FROM deepBufferChunk").get() as { n: number };
    if (total.n === 0) {
      return {
        sessions: [], notCaptured: true,
        configured: store !== null,
        hint: store === null
          ? "no deep buffers, and bulk object storage is NOT configured on this server (S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY unset) — the phone's uploads are being refused with 503, so nothing can arrive until that is set up."
          : "no deep-buffer chunks have ever been uploaded — storage is configured, so this means the phone has not drained any yet: the capture toggle is off, the strap is a WHOOP 4.0 (5/MG-only), or no sync has run since capture started.",
      };
    }
    // Anchor on the archive's own extent when no window is given — "do I have anything, ever?"
    // shouldn't require guessing a range.
    const extent = db.prepare("SELECT MIN(firstStrapTs) a, MAX(lastStrapTs) b FROM deepBufferChunk WHERE firstStrapTs IS NOT NULL").get() as { a: number | null; b: number | null };
    if (extent.a === null || extent.b === null) {
      return { sessions: [], notCaptured: true, configured: store !== null, hint: "chunks exist but none carry a strap_ts — every captured frame was too short to hold the strap's own timestamp at offset 15, so the archive cannot be placed on a timeline." };
    }
    const fromTs = args.from ? toTs(args.from) : extent.a;
    const toT = args.to ? toTs(args.to, true) : extent.b;
    if (!Number.isFinite(fromTs) || !Number.isFinite(toT)) return { error: "bad_range" };
    if (toT - fromTs > COVERAGE_MAX_SPAN_S) return { error: "span_too_wide", maxDays: 366 };

    // Overlap, not containment: a chunk straddling the window boundary still holds buffers inside it.
    const rows = db.prepare(
      `SELECT * FROM deepBufferChunk WHERE firstStrapTs IS NOT NULL AND lastStrapTs >= ? AND firstStrapTs <= ?
       ORDER BY firstStrapTs`).all(fromTs, toT) as ChunkRow[];
    if (rows.length === 0) {
      return {
        sessions: [], notCaptured: true, configured: store !== null,
        window: { fromTs, toTs: toT },
        dataExtent: { firstStrapTs: extent.a, lastStrapTs: extent.b },
        hint: "no deep buffers in THIS range, though the archive holds some elsewhere — see dataExtent, or call with no from/to to see every capture run.",
      };
    }
    const gap = Math.min(86_400, Math.max(1, args.gapSeconds ?? DEFAULT_GAP_S));
    type S = { startTs: number; endTs: number; chunks: number; lines: number; storedBytes: number; rawBytes: number; n1244: number; n2140: number; nOther: number; nImu: number; badLines: number; generations: Set<string> };
    const sessions: S[] = [];
    let cur: S | null = null;
    for (const r of rows) {
      if (!cur || r.firstStrapTs! - cur.endTs > gap) {
        cur = { startTs: r.firstStrapTs!, endTs: r.lastStrapTs!, chunks: 0, lines: 0, storedBytes: 0, rawBytes: 0, n1244: 0, n2140: 0, nOther: 0, nImu: 0, badLines: 0, generations: new Set() };
        sessions.push(cur);
      }
      cur.endTs = Math.max(cur.endTs, r.lastStrapTs!);
      cur.chunks += 1; cur.lines += r.lines; cur.storedBytes += r.storedBytes; cur.rawBytes += r.rawBytes;
      cur.n1244 += r.n1244; cur.n2140 += r.n2140; cur.nOther += r.nOther; cur.nImu += r.nImu;
      cur.badLines += r.badLines;
      cur.generations.add(r.generation);
    }
    const out = sessions.map((s) => {
      const spanSeconds = s.endTs - s.startTs + 1;
      return {
        startTs: s.startTs, endTs: s.endTs,
        start: new Date(s.startTs * 1000).toISOString(), end: new Date(s.endTs * 1000).toISOString(),
        spanSeconds,
        // The strap banks ONE 1244-B + ONE 2140-B buffer per second of history, so a complete run has
        // n1244 == n2140 == spanSeconds. Reported as separate counts rather than a single "coverage"
        // ratio precisely because the two can diverge, and which one is short is the diagnostic.
        buffers: s.lines, imuBuffers: s.n1244, opticalBuffers: s.n2140, otherBuffers: s.nOther,
        decodedImuBuffers: s.nImu,
        // Nominal, per the 1-per-second rule above. Named "expected" because it is derived from the
        // protocol fact, not measured — the manifest cannot see inside a chunk (see this tool's doc).
        expectedPerKind: spanSeconds,
        ...(s.badLines > 0 ? { badLines: s.badLines } : {}),
        chunks: s.chunks, generations: [...s.generations],
        storedBytes: s.storedBytes, rawBytes: s.rawBytes,
        compressionRatio: s.storedBytes > 0 ? round3(s.rawBytes / s.storedBytes) : null,
      };
    });
    const storedBytes = out.reduce((a, s) => a + s.storedBytes, 0);
    const rawBytes = out.reduce((a, s) => a + s.rawBytes, 0);
    return {
      sessions: out,
      totals: {
        sessions: out.length, chunks: out.reduce((a, s) => a + s.chunks, 0),
        buffers: out.reduce((a, s) => a + s.buffers, 0),
        storedBytes, rawBytes,
        storedMB: round3(storedBytes / 1_048_576), rawMB: round3(rawBytes / 1_048_576),
        compressionRatio: storedBytes > 0 ? round3(rawBytes / storedBytes) : null,
      },
      window: { fromTs, toTs: toT },
      dataExtent: { firstStrapTs: extent.a, lastStrapTs: extent.b },
      configured: store !== null,
    };
  } finally { db.close(); }
}

/** Hard ceilings. The archive is ~9 GB/month of hex — an MCP tool must never be a route to stream it. */
const WINDOW_MAX_SPAN_S = 6 * 3600;
const MAX_BUFFERS = 500;
const MAX_HEX_BUFFERS = 5;
const MAX_CHUNKS_FETCHED = 8;

/**
 * deep_buffer_window — what the buffers in a narrow window actually ARE. Fetches the covering chunks
 * from object storage, inflates them, and returns per-buffer METADATA (plus the already-decoded IMU
 * feature summary the capture path inlines).
 *
 * Raw hex is OPT-IN and capped at 5 buffers. This is the tool's central design constraint: one 2140-B
 * buffer is ~4.3 KB of hex, one second of capture is ~6.8 KB across both buffers, and an hour is ~24 MB
 * — pushing that through an MCP response would blow any context window and cost more than it could
 * possibly inform. Bulk access is the `objects` handles: signed URLs to the compressed chunks, which a
 * decoder script downloads directly and streams. Summaries and handles through MCP; bytes out-of-band.
 */
export async function deepBufferWindow(cfg: Config, args: { from: string; to: string; sizes?: number[]; includeHex?: boolean; maxBuffers?: number }) {
  const store: ObjectStore | null = makeObjectStore(cfg);
  if (!store) return { buffers: [], configured: false, hint: "bulk object storage is not configured on this server (S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY unset) — no deep buffers can be stored or read." };
  const fromTs = toTs(args.from), toT = toTs(args.to, true);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toT)) return { error: "bad_range" };
  if (toT - fromTs > WINDOW_MAX_SPAN_S) {
    return { error: "span_too_wide", maxHours: WINDOW_MAX_SPAN_S / 3600, hint: "this reads raw buffers out of object storage — use deep_buffer_coverage for the wide 'what do I have' question, then narrow to a window worth reading." };
  }
  const db = openServerDb(cfg);
  let rows: ChunkRow[];
  try {
    rows = db.prepare(
      `SELECT * FROM deepBufferChunk WHERE firstStrapTs IS NOT NULL AND lastStrapTs >= ? AND firstStrapTs <= ?
       ORDER BY firstStrapTs LIMIT ?`).all(fromTs, toT, MAX_CHUNKS_FETCHED + 1) as ChunkRow[];
  } finally { db.close(); }
  if (rows.length === 0) {
    return { buffers: [], notCaptured: true, configured: true, window: { fromTs, toTs: toT }, hint: "no deep-buffer chunks overlap this window — call deep_buffer_coverage (no from/to) to see where the archive actually has data." };
  }
  const chunkCapped = rows.length > MAX_CHUNKS_FETCHED;
  const fetch = rows.slice(0, MAX_CHUNKS_FETCHED);

  const maxBuffers = Math.min(MAX_BUFFERS, Math.max(1, args.maxBuffers ?? 200));
  const wantSizes = args.sizes && args.sizes.length ? new Set(args.sizes) : null;
  const buffers: Record<string, unknown>[] = [];
  let scanned = 0, hexEmitted = 0;
  const failedObjects: string[] = [];

  for (const row of fetch) {
    let inflated: Buffer;
    try {
      inflated = zlib.inflateRawSync(await store.get(row.objectKey), { maxOutputLength: cfg.maxDeepbufRawBytes });
    } catch {
      // A missing/corrupt object is a REAL fact about the archive (an orphaned manifest row, a bucket
      // lifecycle rule, a failed put whose DB row landed anyway) and is reported, not thrown — one bad
      // chunk must not deny the caller the rest of the window.
      failedObjects.push(row.objectKey);
      continue;
    }
    for (const text of inflated.toString("utf8").split("\n")) {
      if (!text) continue;
      let line: any;
      try { line = JSON.parse(text); } catch { continue; }
      if (typeof line.strap_ts !== "number" || line.strap_ts < fromTs || line.strap_ts > toT) continue;
      if (wantSizes && !wantSizes.has(line.size)) continue;
      scanned += 1;
      if (buffers.length >= maxBuffers) continue;
      const emitHex = args.includeHex === true && hexEmitted < MAX_HEX_BUFFERS;
      if (emitHex) hexEmitted += 1;
      buffers.push({
        tsMs: line.ts_ms, strapTs: line.strap_ts,
        ts: typeof line.strap_ts === "number" ? new Date(line.strap_ts * 1000).toISOString() : null,
        size: line.size, offload: line.offload,
        kind: line.size === 1244 ? "imu-6axis-100hz" : line.size === 2140 ? "optical-ppg-undecoded" : "other",
        ...(line.imu ? { imu: line.imu } : {}),
        ...(emitHex ? { hex: line.hex } : {}),
        // The handle for THIS buffer's bytes when hex wasn't emitted: the object it lives in.
        ...(emitHex ? {} : { objectKey: row.objectKey }),
      });
    }
  }

  // Signed URLs are the bulk path — a decoder script pulls the compressed chunks directly rather than
  // paging megabytes of hex through the model. 1h is long enough to download and short enough that a
  // URL pasted into a transcript is not a durable credential.
  const objects = await Promise.all(fetch.map(async (r) => ({
    key: r.objectKey, generation: r.generation, byteStart: r.byteStart, byteEnd: r.byteEnd,
    storedBytes: r.storedBytes, rawBytes: r.rawBytes, lines: r.lines,
    firstStrapTs: r.firstStrapTs, lastStrapTs: r.lastStrapTs,
    encoding: "raw-deflate (RFC1951, no zlib header) of newline-delimited JSON",
    url: await store.signedUrl(r.objectKey, 3600),
  })));

  return {
    buffers, objects, configured: true, window: { fromTs, toTs: toT },
    matched: scanned, returned: buffers.length,
    ...(scanned > buffers.length ? { truncated: true, hint: `${scanned} buffers matched, ${buffers.length} returned — raise maxBuffers (cap ${MAX_BUFFERS}), narrow the window, or filter with sizes:[1244] / [2140].` } : {}),
    ...(args.includeHex === true && scanned > MAX_HEX_BUFFERS ? { hexCapped: true, hexHint: `hex was emitted for the first ${MAX_HEX_BUFFERS} buffers only — one 2140-B buffer is ~4.3 KB of hex, so a full window is megabytes. Use the signed URLs in \`objects\` to pull the raw chunks for decoding.` } : {}),
    ...(chunkCapped ? { chunksCapped: true, chunksHint: `more than ${MAX_CHUNKS_FETCHED} chunks overlap this window; only the earliest ${MAX_CHUNKS_FETCHED} were read. Narrow from/to.` } : {}),
    ...(failedObjects.length ? { failedObjects, failedHint: "these manifest rows point at objects that could not be read — the archive has a hole here." } : {}),
  };
}

export function registerDeepBufferTools(server: McpServer, cfg: Config): void {
  server.registerTool("deep_buffer_coverage", {
    title: "Deep-buffer archive coverage (raw WHOOP 5/MG offload buffers)",
    description: "WHERE the RAW WHOOP 5/MG high-rate offload buffers exist in the cloud archive, and how much of them there is — answered from the manifest alone, so no object is fetched and the call is cheap regardless of archive size. With from/to OMITTED (the default, anchoring on the archive's own extent) this answers 'do I have any raw deep buffers, ever?'. NOT the same question as imu_coverage: that reports DECODED per-second imuActivity rows in the mirror, this reports the RAW banked buffers — including the 2140-B optical/PPG buffers whose layout is still undecoded (#423) and which therefore exist NOWHERE ELSE. A range can have one and not the other. Returns contiguous capture SESSIONS (a run is the natural unit of 'did it work', and sessions are timezone-independent so an overnight is never split at a meaningless UTC boundary). Per session: startTs/endTs plus ISO start/end (UTC), spanSeconds, `imuBuffers` (1244-B, 6-axis 100 Hz) and `opticalBuffers` (2140-B, PPG), `decodedImuBuffers` (how many carry the inline decoded feature summary), chunks/generations, storedBytes vs rawBytes and their compressionRatio. THE KEY CHECK: the strap banks exactly ONE 1244-B AND ONE 2140-B buffer per second of history, so a complete run has imuBuffers == opticalBuffers == expectedPerKind (= spanSeconds); a shortfall in one and not the other is the diagnostic, which is why these are separate counts and not one blended coverage ratio. RESOLUTION LIMIT, stated plainly: sessions are built from per-CHUNK strap_ts extents (~16 MB of log per chunk), so a gap INSIDE a chunk is invisible here — use deep_buffer_window for per-second truth. `badLines` appears only when a chunk contained unparseable lines. configured:false means bulk object storage is not set up on the server, so uploads are being refused and nothing can arrive.",
    inputSchema: {
      from: z.string().optional().describe("Omit both from and to to cover the whole archive."),
      to: z.string().optional(),
      gapSeconds: z.number().int().min(1).max(86400).optional().describe("A silence longer than this ends a session (default 60)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(deepBufferCoverage(cfg, a)));

  server.registerTool("deep_buffer_window", {
    title: "Deep-buffer window (raw buffer metadata + download handles)",
    description: "What the raw WHOOP 5/MG deep buffers in a NARROW window (max 6 hours) actually are: fetches the covering chunks from object storage, inflates them, and returns PER-BUFFER METADATA — strapTs + ISO ts, size, offload flag, `kind` ('imu-6axis-100hz' for the 1244-B buffer, 'optical-ppg-undecoded' for the 2140-B one), and the decoded IMU feature summary (cadence/energy/jerk/gyro) that the capture path inlines for every 1244-B buffer. DOES NOT STREAM HEX BY DEFAULT, and this is deliberate: one 2140-B buffer is ~4.3 KB of hex and one second of capture is ~6.8 KB across both buffers, so an hour is ~24 MB — far past any context window and useless to reason over. Pass includeHex:true to get the raw hex for at most the FIRST 5 buffers (enough to eyeball a layout by hand). For real decoding work use the `objects` array instead: each entry carries the chunk's key, byte range, line count and a 1-hour SIGNED URL to the compressed object, which a decoder script downloads and streams directly — summaries and handles through MCP, bytes out-of-band. Objects are raw-DEFLATE (RFC1951, NO zlib header — inflate with inflateRaw/`zlib.inflateRawSync`/`python zlib.decompress(b, -15)`, not plain inflate) over newline-delimited JSON. Filter with sizes:[1244] or sizes:[2140] to isolate one buffer family — the usual move when working the undecoded optical layout. truncated:true means more buffers matched than were returned (raise maxBuffers, cap 500, or narrow the window); failedObjects lists manifest rows whose object could not be read, i.e. a real hole in the archive. Use deep_buffer_coverage first for the wide 'what do I have' question.",
    inputSchema: {
      from: z.string(), to: z.string(),
      sizes: z.array(z.number().int()).optional().describe("Keep only these buffer byte-sizes, e.g. [1244] (IMU) or [2140] (optical)."),
      includeHex: z.boolean().optional().describe("Emit raw hex for the first 5 matching buffers. Off by default — use the signed URLs in `objects` for bulk."),
      maxBuffers: z.number().int().min(1).max(MAX_BUFFERS).optional().describe("Metadata rows to return (default 200, cap 500)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => asTool(await deepBufferWindow(cfg, a)));
}
