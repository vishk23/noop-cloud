import fs from "node:fs";
import zlib from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// Why this module exists (2026-07-26 OOM, second post-mortem of the same week):
//
// /ingest used to read the whole .noopbak into a Buffer (express.raw), hand that Buffer to AdmZip,
// and call entry.getData() — which materialises a SECOND buffer holding the entire decompressed
// database. For VK's 608 MB database arriving as a ~200 MB zip that is ~800 MB of live buffers plus
// the transients of Buffer.concat and inflate, measured at 1.3-1.5 GB peak RSS. On a 2 GB machine
// the kernel killed node mid-request and Fly's proxy answered the phone `502`. The phone had not
// synced for 10 days.
//
// The same failure had already been "fixed" twice by doubling the machine's RAM (512 MB -> 1 GB
// after a 382 MB database OOMed, 1 GB -> 2 GB after the next one). Memory use scaled with the
// user's database, so each doubling only bought the weeks it took the database to grow into it.
//
// This module removes the scaling entirely: the zip is read from a file on the volume, and the
// entry is inflated straight to the staged path through a 64 KB stream. Nothing proportional to the
// database is ever resident. It reads the ZIP structures directly rather than through adm-zip
// because adm-zip has no streaming entry API at all — getData() is buffer-only by construction.

export class ZipError extends Error {
  constructor(public code: string, msg?: string) { super(msg ?? code); }
}

/** Local file header, central directory header, EOCD, ZIP64 EOCD + its locator. */
const SIG_LFH = 0x04034b50, SIG_CDH = 0x02014b50, SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50, SIG_ZIP64_LOC = 0x07064b50;
/** EOCD is 22 bytes plus a comment of at most 64 KB, and the ZIP64 locator sits just before it. */
const EOCD_SEARCH_BYTES = 22 + 0xffff + 20;
/** A central directory this large is not a NOOP backup; the bound keeps a hostile zip from allocating. */
const MAX_CENTRAL_DIR_BYTES = 8 * 1024 * 1024;
/** 32-bit fields set to this are "see the ZIP64 extra field". */
const U32_MAX = 0xffffffff;

export const COMPRESSION_STORE = 0, COMPRESSION_DEFLATE = 8;

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. Anything else is rejected. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readAt(fd: number, length: number, position: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  const read = fs.readSync(fd, buf, 0, length, position);
  return read === length ? buf : buf.subarray(0, read);
}

/**
 * Every entry in the archive's central directory.
 *
 * The central directory is the authoritative index — the local file headers may carry zeroed sizes
 * when a writer streams entries out (the data-descriptor convention), whereas the central directory
 * is always written last, with the real numbers. ZIPFoundation on the phone rewrites both; adm-zip
 * (the test fixtures) writes both up front. Reading the central directory is what makes this correct
 * for any conforming writer rather than for the two we happen to have.
 */
export function readCentralDirectory(fd: number, fileSize: number): ZipEntry[] {
  if (fileSize < 22) throw new ZipError("bad_zip", "file too small to be a zip");
  const tailLen = Math.min(fileSize, EOCD_SEARCH_BYTES);
  const tail = readAt(fd, tailLen, fileSize - tailLen);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("bad_zip", "no end-of-central-directory record");

  let entryCount = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  // ZIP64: only reachable for >4 GB archives or >65535 entries, neither of which a .noopbak hits
  // today — but a writer is free to emit it anyway, and silently misreading 0xffffffff as a real
  // offset would be a confusing corruption rather than a clean rejection.
  if (entryCount === 0xffff || cdSize === U32_MAX || cdOffset === U32_MAX) {
    const locAt = eocd - 20;
    if (locAt < 0 || tail.readUInt32LE(locAt) !== SIG_ZIP64_LOC) throw new ZipError("bad_zip", "zip64 fields without a zip64 locator");
    const z64Offset = Number(tail.readBigUInt64LE(locAt + 8));
    const z64 = readAt(fd, 56, z64Offset);
    if (z64.length < 56 || z64.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new ZipError("bad_zip", "bad zip64 end-of-central-directory");
    entryCount = Number(z64.readBigUInt64LE(32));
    cdSize = Number(z64.readBigUInt64LE(40));
    cdOffset = Number(z64.readBigUInt64LE(48));
  }

  if (cdSize > MAX_CENTRAL_DIR_BYTES) throw new ZipError("bad_zip", `central directory ${cdSize} bytes is implausible`);
  if (cdOffset + cdSize > fileSize) throw new ZipError("bad_zip", "central directory runs past end of file");
  const cd = readAt(fd, cdSize, cdOffset);
  if (cd.length !== cdSize) throw new ZipError("bad_zip", "truncated central directory");

  const entries: ZipEntry[] = [];
  let p = 0;
  while (p + 46 <= cd.length && entries.length < entryCount) {
    if (cd.readUInt32LE(p) !== SIG_CDH) throw new ZipError("bad_zip", "bad central directory header");
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localHeaderOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    // ZIP64 extra field (0x0001): the 32-bit fields above are placeholders, and the 64-bit
    // replacements appear in this exact order, ONLY for the ones that were 0xffffffff.
    if (uncompressedSize === U32_MAX || compressedSize === U32_MAX || localHeaderOffset === U32_MAX) {
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      let q = 0, found = false;
      while (q + 4 <= extra.length) {
        const id = extra.readUInt16LE(q), size = extra.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          const next = () => { const v = Number(extra.readBigUInt64LE(r)); r += 8; return v; };
          if (uncompressedSize === U32_MAX && r + 8 <= extra.length) uncompressedSize = next();
          if (compressedSize === U32_MAX && r + 8 <= extra.length) compressedSize = next();
          if (localHeaderOffset === U32_MAX && r + 8 <= extra.length) localHeaderOffset = next();
          found = true;
          break;
        }
        q += 4 + size;
      }
      if (!found) throw new ZipError("bad_zip", "zip64 placeholder without a zip64 extra field");
    }

    // Bit 0 of the general-purpose flags. An encrypted entry inflates to garbage rather than
    // failing, so it has to be refused by name.
    if (flags & 0x1) throw new ZipError("encrypted", `entry ${name} is encrypted`);

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.length) throw new ZipError("bad_zip", "no entries");
  return entries;
}

/** Byte offset of an entry's payload: past its LOCAL header, whose name/extra lengths can differ from the central copy's. */
function dataOffset(fd: number, entry: ZipEntry, fileSize: number): number {
  const lfh = readAt(fd, 30, entry.localHeaderOffset);
  if (lfh.length < 30 || lfh.readUInt32LE(0) !== SIG_LFH) throw new ZipError("bad_zip", `no local file header for ${entry.name}`);
  const off = entry.localHeaderOffset + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);
  if (off >= fileSize) throw new ZipError("bad_zip", "entry data starts past end of file");
  return off;
}

/**
 * Enforces the two things that used to be checked only after the whole database was in memory: the
 * decompressed-size ceiling (the zip-bomb bound) and the SQLite magic. Both now fail on the FIRST
 * chunk past the line, so a bomb or a garbage payload costs 64 KB instead of a gigabyte.
 */
class GuardStream extends Transform {
  bytes = 0;
  private checked = false;
  private head: Buffer[] = [];
  private headLen = 0;
  constructor(private maxBytes: number, private magic: Buffer | null) { super(); }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      return cb(new ZipError("too_large", `decompressed entry exceeds ${this.maxBytes} bytes`));
    }
    if (this.magic && !this.checked) {
      this.head.push(chunk); this.headLen += chunk.length;
      if (this.headLen >= this.magic.length) {
        const head = Buffer.concat(this.head, this.headLen).subarray(0, this.magic.length);
        this.head = []; this.checked = true;
        if (!head.equals(this.magic)) return cb(new ZipError("bad_magic"));
      }
    }
    this.push(chunk);
    cb();
  }

  override _flush(cb: (e?: Error) => void): void {
    // Shorter than the magic itself: never a database, and it must not slip through unchecked.
    if (this.magic && !this.checked && this.bytes > 0) return cb(new ZipError("bad_magic"));
    cb();
  }
}

/**
 * Inflate one entry straight to `destPath`. Peak memory is the stream buffers — a few hundred KB —
 * no matter how large the entry is.
 *
 * `maxBytes` bounds the OUTPUT as it is produced, so it holds even when the central directory lies
 * about uncompressedSize (that field is attacker-controlled and can be forged, including to 0).
 */
export async function extractEntryToFile(
  zipPath: string, fd: number, fileSize: number, entry: ZipEntry, destPath: string,
  opts: { maxBytes: number; expectMagic?: Buffer },
): Promise<number> {
  if (entry.method !== COMPRESSION_STORE && entry.method !== COMPRESSION_DEFLATE) {
    throw new ZipError("unsupported_compression", `entry ${entry.name} uses compression method ${entry.method}`);
  }
  const start = dataOffset(fd, entry, fileSize);
  // Trust the central directory for how much to READ (bounded by the file), never for how much to
  // BELIEVE — the output ceiling above is what actually protects memory and disk.
  const end = entry.compressedSize > 0 ? Math.min(start + entry.compressedSize, fileSize) - 1 : fileSize - 1;
  if (end < start) throw new ZipError("bad_zip", `entry ${entry.name} has no data`);

  const source = fs.createReadStream(zipPath, { start, end, highWaterMark: 64 * 1024 });
  const guard = new GuardStream(opts.maxBytes, opts.expectMagic ?? null);
  const sink = fs.createWriteStream(destPath, { highWaterMark: 64 * 1024 });
  try {
    if (entry.method === COMPRESSION_DEFLATE) await pipeline(source, zlib.createInflateRaw(), guard, sink);
    else await pipeline(source, guard, sink);
  } catch (e) {
    // A ZipError is our own verdict and keeps its code. A zlib fault means the DEFLATE stream is
    // malformed, which is a bad upload (400 bad_zip) — not a server failure. Everything else
    // (ENOSPC above all) propagates untouched so the storage classifier upstream still sees it.
    if (e instanceof ZipError) throw e;
    if (isZlibError(e)) throw new ZipError("bad_zip", `corrupt compressed entry: ${(e as Error).message}`);
    throw e;
  }
  return guard.bytes;
}

// Deliberately the `Z_*` code alone and NOT a numeric `errno`: fs errors carry an errno too, and
// classifying an ENOSPC as "corrupt zip" would answer 400 to a full disk — telling the phone to
// discard a perfectly good backup at exactly the moment the server needed it to retry later.
function isZlibError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("Z_");
}
