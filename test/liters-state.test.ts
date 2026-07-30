import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { buildNoopbak } from "./fixtures/make-fixture.js";
import { ingestNoopbak } from "../src/ingest.js";
import { readStatus, invalidateLitersLineage, bucketBytes, txidPath } from "../src/liters/state.js";
import { startLitersSink } from "../src/liters/sink.js";

// The two replication paths share exactly one file — mirror.sqlite — and exactly one moment of
// coordination: the instant `/ingest` renames a new database over it. Everything that can go wrong
// between them goes wrong there, so it gets its own suite.

const dataDir = path.join(process.cwd(), "test/.tmp/liters-state");
const bucketDir = path.join(dataDir, "ltx-bucket");
const mirrorPath = path.join(dataDir, "mirror.sqlite");
const statusPath = path.join(dataDir, "liters-sink-status.json");

const cfg = (over: Record<string, unknown> = {}) => ({
  dataDir, mirrorPath, serverDbPath: path.join(dataDir, "server.sqlite"),
  maxIngestBytes: 262_144_000, minFreeBytes: 1024, stagedSweepAgeMs: 3_600_000,
  roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y"), port: 0,
  liters: {
    enabled: true, sinkToken: "sink-token-internal-0123456789", sinkAddr: "127.0.0.1:9736",
    binPath: path.join(dataDir, "no-such-binary"), bucketDir, statusPath,
    maxPushBytes: 1_048_576, staleStatusSeconds: 120,
  },
  ...over,
} as any);

/** What a live bucket looks like: `{root}/ltx/{level}/{min:016x}-{max:016x}.ltx`. */
function seedLineage() {
  fs.mkdirSync(path.join(bucketDir, "ltx", "0"), { recursive: true });
  fs.writeFileSync(path.join(bucketDir, "ltx", "0", "0000000000000001-0000000000000002.ltx"), Buffer.alloc(8192, 3));
  fs.mkdirSync(path.join(bucketDir, "ltx", "9"), { recursive: true });
  fs.writeFileSync(path.join(bucketDir, "ltx", "9", "0000000000000001-0000000000000001.ltx"), Buffer.alloc(4096, 4));
  fs.writeFileSync(`${mirrorPath}-txid`, "0000000000000002\n");
}

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

describe("liters lineage invalidation", () => {
  it("removes the bucket AND the position sidecar", async () => {
    seedLineage();
    expect(bucketBytes(cfg())).toBe(12288);

    const out = invalidateLitersLineage(cfg());
    expect(out).toEqual({ bucketRemoved: true, sidecarRemoved: true });
    expect(fs.existsSync(bucketDir)).toBe(false);
    expect(fs.existsSync(txidPath(cfg()))).toBe(false);
  });

  it("also clears the applier's fixed-name spools, so nothing from the old lineage is left to confuse an incident", () => {
    seedLineage();
    for (const s of [".apply.tmp", ".tmp", ".compact.tmp"]) fs.writeFileSync(`${mirrorPath}${s}`, "x");
    invalidateLitersLineage(cfg());
    for (const s of [".apply.tmp", ".tmp", ".compact.tmp"]) expect(fs.existsSync(`${mirrorPath}${s}`)).toBe(false);
  });

  it("is idempotent and never throws on a server that has never used the feature", () => {
    expect(invalidateLitersLineage(cfg())).toEqual({ bucketRemoved: false, sidecarRemoved: false });
    expect(invalidateLitersLineage(cfg())).toEqual({ bucketRemoved: false, sidecarRemoved: false });
  });

  it("leaves the mirror itself completely alone — this severs a lineage, it does not delete data", () => {
    seedLineage();
    fs.writeFileSync(mirrorPath, "the database");
    invalidateLitersLineage(cfg());
    expect(fs.readFileSync(mirrorPath, "utf8")).toBe("the database");
  });
});

describe("/ingest severs the liters lineage when it swaps the mirror", () => {
  it("wipes the bucket and the sidecar, because they describe a database that no longer exists", async () => {
    seedLineage();
    const zip = path.join(dataDir, "in.noopbak");
    buildNoopbak(zip);

    await ingestNoopbak(fs.readFileSync(zip), cfg());

    // The whole hazard in one assertion: had these survived, the sink's next round would have
    // applied LTX pages from the OLD database on top of the one /ingest just installed — two
    // lineages spliced together, silently, inside the file every MCP tool reads.
    expect(fs.existsSync(bucketDir)).toBe(false);
    expect(fs.existsSync(txidPath(cfg()))).toBe(false);
    expect(fs.existsSync(mirrorPath)).toBe(true);
  });

  it("does nothing at all on a config with no liters section — every server today", async () => {
    const bare = cfg();
    delete bare.liters;
    seedLineage();
    const zip = path.join(dataDir, "in.noopbak");
    buildNoopbak(zip);

    await ingestNoopbak(fs.readFileSync(zip), bare);

    // /ingest's behaviour is unchanged when the feature was never configured.
    expect(fs.existsSync(bucketDir)).toBe(true);
    expect(fs.existsSync(txidPath(cfg()))).toBe(true);
    expect(fs.existsSync(mirrorPath)).toBe(true);
  });

  it("a FAILED ingest leaves the lineage intact — only a completed swap invalidates", async () => {
    seedLineage();
    const broken = cfg();
    broken.minFreeBytes = Number.MAX_SAFE_INTEGER; // refused by the space preflight
    const zip = path.join(dataDir, "in.noopbak");
    buildNoopbak(zip);

    await expect(ingestNoopbak(fs.readFileSync(zip), broken)).rejects.toThrow();

    // The mirror was never replaced, so the replica's position is still true. Invalidating here
    // would throw away a valid lineage and force a needless full re-baseline from the phone.
    expect(fs.existsSync(bucketDir)).toBe(true);
    expect(fs.existsSync(txidPath(cfg()))).toBe(true);
  });
});

describe("liters status file", () => {
  it("reads a published status", () => {
    fs.writeFileSync(statusPath, JSON.stringify({
      ok: true, position: 42, bucketMax: 42, lastSyncAtMs: 1, lastError: null, lockBusy: false,
      applies: 7, lockBusyTotal: 0, errorsTotal: 0, freeBytes: 1, bucketBytes: 2, mirrorBytes: 3,
      spaceOk: true, sweptTotal: 0, startedAtMs: 1, minFreeBytes: 4,
    }));
    expect(readStatus(cfg())?.position).toBe(42);
  });

  it("treats a missing or torn status file as 'no status', never as a throw", () => {
    expect(readStatus(cfg())).toBeNull();
    // A crash mid-write cannot produce this (the sink publishes by rename) but a truncated read can,
    // and a diagnostic that throws is a diagnostic that vanishes exactly when it is needed.
    fs.writeFileSync(statusPath, '{"ok":true,"positi');
    expect(readStatus(cfg())).toBeNull();
    fs.writeFileSync(statusPath, "null");
    expect(readStatus(cfg())).toBeNull();
  });
});

describe("liters sink supervisor", () => {
  it("stays null when the feature is off, and never starts a process", () => {
    expect(startLitersSink(cfg({ liters: { ...cfg().liters, enabled: false } }))).toBeNull();
  });

  it("stays null when the config has no liters section at all", () => {
    const bare = cfg();
    delete bare.liters;
    expect(startLitersSink(bare)).toBeNull();
  });

  it("does not take the server down when the binary is missing — /ingest is the fallback", () => {
    // The image is built with a Rust stage, but a hand-run container or a partial build may not have
    // it. A cloud that refuses to boot is strictly worse than one missing an optional path.
    expect(startLitersSink(cfg())).toBeNull();
  });

  it("spawns, supervises and stops a real child process", async () => {
    const fake = path.join(dataDir, "fake-sink");
    fs.writeFileSync(fake, "#!/bin/sh\necho \"liters-sink ready: fake on $LITERS_SINK_ADDR\"\nsleep 30\n");
    fs.chmodSync(fake, 0o755);

    const h = startLitersSink(cfg({ liters: { ...cfg().liters, binPath: fake } }))!;
    expect(h).not.toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    expect(h.running()).toBe(true);
    expect(h.restarts()).toBe(0);
    h.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(h.running()).toBe(false);
  });

  it("passes the SAME free-space floor Express enforces, so the two preflights cannot disagree", async () => {
    const envDump = path.join(dataDir, "env-sink");
    const out = path.join(dataDir, "env.txt");
    fs.writeFileSync(envDump, `#!/bin/sh\nenv > ${out}\nsleep 5\n`);
    fs.chmodSync(envDump, 0o755);

    const c = cfg({ minFreeBytes: 123456789 });
    const h = startLitersSink({ ...c, liters: { ...c.liters, binPath: envDump } } as any)!;
    await new Promise((r) => setTimeout(r, 400));
    h.stop();

    const env = fs.readFileSync(out, "utf8");
    expect(env).toContain("LITERS_MIN_FREE_BYTES=123456789");
    expect(env).toContain(`LITERS_BUCKET_DIR=${bucketDir}`);
    expect(env).toContain(`LITERS_MIRROR_PATH=${mirrorPath}`);
    // The sink's spool must land on the DATA VOLUME, not the container's root filesystem: a
    // snapshot push is the whole database and TMPDIR defaults to /tmp.
    expect(env).toMatch(/LITERS_TMP_DIR=.*ltx-tmp/);
  });
});
