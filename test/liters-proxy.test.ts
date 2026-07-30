import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path"; import http from "node:http";
import { createApp } from "../src/server.js";

// `/liters/*` is a streaming reverse proxy in front of the Rust sink, which is where the actual
// liters HTTP replication protocol lives (liters-sink/, embedding liters_storage::HttpServer). These
// tests therefore assert the FOUR things Express is responsible for — auth, disk preflight, size
// ceiling, bounded drain — and one thing it must be careful NOT to do, which is mangle the protocol
// on its way through. The protocol itself is covered end to end against a real liters `Writer` in
// liters-sink/tests/receive_e2e.rs.
//
// The upstream here is a stub, deliberately: it lets a test assert exactly what the proxy sent
// (path, headers, streamed body) without a Rust build in the loop.

const dataDir = path.join(process.cwd(), "test/.tmp/liters-proxy");
const RW = "rw".padEnd(40, "y");
const RO = "ro".padEnd(40, "x");

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
let upstream: http.Server;
let upstreamPort = 0;
let seen: Seen[] = [];
let respond: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      respond(req, res, body);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as any).port;
});
afterAll(() => { upstream.close(); });

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  seen = [];
  respond = (_req, res, body) => {
    // What a liters mount answers a successful PUT: the file's listing line, plus the protocol
    // header every liters client validates on EVERY response.
    res.writeHead(200, { "content-type": "text/plain", "x-liters-protocol": "1" });
    res.end(`0000000000000001-0000000000000001.ltx ${body.length} -\n`);
  };
});

const cfg = (over: Record<string, unknown> = {}) => {
  const { liters: litersOver, ...rest } = over;
  return {
  dataDir,
  mirrorPath: path.join(dataDir, "mirror.sqlite"),
  serverDbPath: path.join(dataDir, "server.sqlite"),
  maxIngestBytes: 262_144_000,
  minFreeBytes: 1024,
  stagedSweepAgeMs: 3_600_000,
  roToken: RO, rwToken: RW, port: 0,
  liters: {
    enabled: true,
    sinkToken: "sink-token-internal-0123456789",
    sinkAddr: `127.0.0.1:${upstreamPort}`,
    binPath: path.join(dataDir, "no-such-binary"),
    bucketDir: path.join(dataDir, "ltx-bucket"),
    statusPath: path.join(dataDir, "liters-sink-status.json"),
    maxPushBytes: 1_048_576,
    staleStatusSeconds: 120,
    ...(litersOver as object ?? {}),
  },
  ...rest,
  } as any;
};

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

function call(
  port: number, method: string, url: string,
  opts: { token?: string | null; body?: Buffer; contentLength?: number; headers?: Record<string, string> } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? RW}`;
    if (opts.contentLength !== undefined) headers["content-length"] = String(opts.contentLength);
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: d }));
    });
    req.on("error", reject);
    if (opts.body) req.end(opts.body); else req.end();
  });
}

async function withApp(c: any, fn: (port: number) => Promise<void>) {
  const server = createApp(c).listen(0);
  try { await fn((server.address() as any).port); } finally { server.close(); }
}

describe("liters proxy — auth", () => {
  it("rejects an unauthenticated push and a read-only token", async () => {
    await withApp(cfg(), async (port) => {
      expect((await call(port, "GET", "/liters/ltx/0", { token: null })).status).toBe(401);
      // `ro` is not enough: this endpoint writes to the mirror's replication lineage.
      expect((await call(port, "GET", "/liters/ltx/0", { token: RO })).status).toBe(401);
      expect(seen).toHaveLength(0);
    });
  });

  it("swaps the phone's token for the loopback token — the RW credential never reaches the sink", async () => {
    await withApp(cfg(), async (port) => {
      await call(port, "GET", "/liters/ltx/0?seek=0000000000000001");
      expect(seen).toHaveLength(1);
      expect(seen[0].headers.authorization).toBe("Bearer sink-token-internal-0123456789");
      expect(seen[0].headers.authorization).not.toContain(RW);
    });
  });
});

describe("liters proxy — protocol pass-through", () => {
  it("strips the /liters mount prefix, since the sink runs base_path: None", async () => {
    await withApp(cfg(), async (port) => {
      await call(port, "GET", "/liters/ltx/0?seek=0000000000000005&meta=1");
      // Exactly the endpoint grammar from docs/http-protocol.md, query intact and un-encoded.
      expect(seen[0].url).toBe("/ltx/0?seek=0000000000000005&meta=1");
    });
  });

  it("forwards a PUT body and returns the sink's status, headers and listing line verbatim", async () => {
    const body = Buffer.alloc(4096, 7);
    await withApp(cfg(), async (port) => {
      const r = await call(port, "PUT", "/liters/ltx/0/0000000000000001-0000000000000001.ltx", { body });
      expect(r.status).toBe(200);
      expect(r.body).toBe("0000000000000001-0000000000000001.ltx 4096 -\n");
      // Clients validate this on EVERY response; dropping it would break every request while
      // looking like a server fault.
      expect(r.headers["x-liters-protocol"]).toBe("1");
      expect(seen[0].method).toBe("PUT");
      expect(seen[0].body.length).toBe(4096);
      expect(seen[0].body.equals(body)).toBe(true);
    });
  });

  it("passes the fencing headers through untouched", async () => {
    await withApp(cfg(), async (port) => {
      await call(port, "PUT", "/liters/ltx/0/0000000000000002-0000000000000002.ltx", {
        body: Buffer.from("x"),
        headers: { "x-liters-writer-id": "vk-iphone", "x-liters-writer-takeover": "1" },
      });
      expect(seen[0].headers["x-liters-writer-id"]).toBe("vk-iphone");
      expect(seen[0].headers["x-liters-writer-takeover"]).toBe("1");
    });
  });

  it("does not forward hop-by-hop headers", async () => {
    await withApp(cfg(), async (port) => {
      await call(port, "GET", "/liters/ltx/0", { headers: { connection: "keep-alive", te: "trailers" } });
      expect(seen[0].headers.te).toBeUndefined();
      // `host` must be the upstream's, never the phone's — a forwarded Host is how a proxy sends a
      // request to the wrong virtual server.
      expect(seen[0].headers.host).toContain("127.0.0.1");
    });
  });

  it("relays a non-200 from the sink without reinterpreting it", async () => {
    // 409 is fencing (writer lease / TXID monotonicity). The client maps it to a NON-retryable
    // Conflict, so turning it into a 500 here would have the phone retry a push that can never be
    // accepted, forever.
    respond = (_req, res) => {
      res.writeHead(409, { "content-type": "text/plain", "x-liters-protocol": "1" });
      res.end("non-monotonic L0 push: 5-5 offered, bucket at 2\n");
    };
    await withApp(cfg(), async (port) => {
      const r = await call(port, "PUT", "/liters/ltx/0/0000000000000005-0000000000000005.ltx", { body: Buffer.from("x") });
      expect(r.status).toBe(409);
      expect(r.body).toContain("non-monotonic");
    });
  });
});

describe("liters proxy — refusals stay deliverable", () => {
  it("413s a push above the ceiling, and the response actually arrives", async () => {
    await withApp(cfg(), async (port) => {
      const r = await call(port, "PUT", "/liters/ltx/0/0000000000000001-0000000000000001.ltx", {
        body: Buffer.alloc(64), contentLength: 2_000_000,
      });
      expect(r.status).toBe(413);
      expect(JSON.parse(r.body).error).toBe("too_large");
      expect(seen).toHaveLength(0); // refused before a byte reached the sink
    });
  });

  it("507s when the volume cannot hold the push — not 400, so the phone retries instead of discarding", async () => {
    await withApp(cfg({ minFreeBytes: Number.MAX_SAFE_INTEGER }), async (port) => {
      const r = await call(port, "PUT", "/liters/ltx/0/0000000000000001-0000000000000001.ltx", {
        body: Buffer.alloc(64), contentLength: 64,
      });
      expect(r.status).toBe(507);
      expect(JSON.parse(r.body).error).toBe("insufficient_space");
      expect(JSON.parse(r.body).detail).toMatch(/headroom/);
      expect(seen).toHaveLength(0);
    });
  });

  it("still preflights a chunked push, where there is no content-length to measure", async () => {
    await withApp(cfg({ minFreeBytes: Number.MAX_SAFE_INTEGER }), async (port) => {
      // No content-length at all: the size term degrades to zero and the headroom floor is what
      // answers. That floor is the number that actually mattered on 2026-07-26.
      const r = await call(port, "PUT", "/liters/ltx/0/0000000000000001-0000000000000001.ltx", { body: Buffer.alloc(64) });
      expect(r.status).toBe(507);
    });
  });

  it("reads never pay the space preflight", async () => {
    await withApp(cfg({ minFreeBytes: Number.MAX_SAFE_INTEGER }), async (port) => {
      // A full volume must not stop a follower catching up or an operator listing the bucket.
      expect((await call(port, "GET", "/liters/ltx/0")).status).toBe(200);
    });
  });

  it("503s with a legible body when the sink is not listening, instead of hanging", async () => {
    // Port 1 is reserved and never listening: the same shape as a crashed or restarting sidecar.
    await withApp(cfg({ liters: { sinkAddr: "127.0.0.1:1" } }), async (port) => {
      const r = await call(port, "PUT", "/liters/ltx/0/0000000000000001-0000000000000001.ltx", { body: Buffer.alloc(64) });
      expect(r.status).toBe(503);
      const j = JSON.parse(r.body);
      expect(j.error).toBe("liters_sink_unavailable");
      expect(j.detail).toMatch(/\/ingest is unaffected/);
    });
  });
});

describe("liters proxy — disabled by default", () => {
  it("answers a legible 503 rather than a bare 404 when the feature is off", async () => {
    await withApp(cfg({ liters: { enabled: false } }), async (port) => {
      const r = await call(port, "PUT", "/liters/ltx/0/0000000000000001-0000000000000001.ltx", { body: Buffer.alloc(64) });
      expect(r.status).toBe(503);
      const j = JSON.parse(r.body);
      expect(j.error).toBe("liters_not_enabled");
      expect(j.configured).toBe(false);
      // The same reassurance /deepbuf learned to give: an unconfigured optional feature must not
      // read like the whole-database upload being broken.
      expect(j.detail).toMatch(/POST \/ingest is unaffected/);
      expect(seen).toHaveLength(0);
    });
  });

  it("still requires auth when disabled — feature presence is not public information", async () => {
    await withApp(cfg({ liters: { enabled: false } }), async (port) => {
      expect((await call(port, "GET", "/liters/ltx/0", { token: null })).status).toBe(401);
    });
  });
});
