import http from "node:http";
import type { IncomingMessage } from "node:http";
import type express from "express";
import type { Config } from "../config.js";
import { tokenScope } from "../auth.js";
import { IngestError, requireSpaceFor } from "../ingest.js";
import { isVolumeError, storageFailureMessage } from "../storage.js";

/**
 * `/liters/*` — the phone's push endpoint.
 *
 * This is a **streaming reverse proxy and nothing else**. It does not parse an LTX file, validate a
 * TXID, evaluate a writer lease, or emit a listing line. Every one of those is `Mount`'s job inside
 * the Rust sink, whose wire format is normative in the liters repo's `docs/http-protocol.md` and is
 * tested there against a Go litestream oracle. The rule this file follows is: **if it is protocol,
 * it belongs upstream.** What Express adds is the four things it is uniquely placed to add —
 *
 *  1. the bearer token the phone already holds (`rw`), swapped for the loopback token;
 *  2. a disk preflight, using the same `requireSpaceFor` that guards `/ingest`;
 *  3. a body-size ceiling;
 *  4. a bounded drain on every rejection.
 *
 * (4) is not politeness. Answering a request whose body is still arriving, without reading some of
 * it, makes the kernel RST the connection — and an RST destroys the response, so a permanent
 * rejection (`401`, `413`) reaches the client as a transport failure, which it retries forever. The
 * liters server does exactly this on all of its error paths; a proxy in front of it that does not is
 * a proxy that converts its own clear errors into mystery timeouts.
 *
 * Express mounts this at `/liters`, so `req.url` here already has the prefix stripped — which is why
 * the sink runs with `base_path: None`. The two approaches are explicitly mutually exclusive: strip
 * at the proxy or configure the prefix on the mount, never both.
 */

/** Hop-by-hop headers are per-connection and must never be forwarded across a proxy (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host",
]);

/**
 * Discard up to `maxBytes` of an unread request body so a rejection is actually deliverable, then
 * settle. Never waits for the whole body: a snapshot push is hundreds of MB and draining it to say
 * "401" would be its own denial of service.
 */
function drainBounded(req: IncomingMessage, maxBytes = 1_048_576): Promise<void> {
  return new Promise((resolve) => {
    if (req.readableEnded || !req.readable) return resolve();
    let seen = 0;
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    req.on("data", (c: Buffer) => { seen += c.length; if (seen >= maxBytes) { req.pause(); done(); } });
    req.on("end", done);
    req.on("error", done);
    req.on("close", done);
    // Belt and braces: a client that sends neither data nor FIN must not park the handler.
    setTimeout(done, 2_000).unref?.();
  });
}

async function reject(
  req: IncomingMessage, res: express.Response, status: number, body: Record<string, unknown>,
): Promise<void> {
  await drainBounded(req);
  if (res.headersSent || res.writableEnded) return;
  try { res.status(status).json(body); } catch { /* socket already gone */ }
}

function splitAddr(addr: string): { host: string; port: number } {
  const i = addr.lastIndexOf(":");
  return { host: addr.slice(0, i) || "127.0.0.1", port: Number(addr.slice(i + 1)) };
}

/**
 * True for the long-lived follow stream, which must not be given an idle timeout — it is idle by
 * design between pushes and only sends a keepalive every 15s.
 */
const isStream = (url: string) => url.split("?")[0].replace(/\/+$/, "").endsWith("/stream");

export function litersProxy(cfg: Config): express.RequestHandler {
  const { host, port } = splitAddr(cfg.liters.sinkAddr);

  return async (req, res) => {
    // Auth first, and by hand rather than via `requireScope`, because a middleware rejection cannot
    // drain the body — see the note above on RSTs eating responses.
    if (tokenScope(cfg, req.header("authorization")) !== "rw") {
      return reject(req, res, 401, { error: "unauthorized" });
    }

    const isWrite = req.method === "PUT" || req.method === "DELETE";

    if (isWrite) {
      const declared = Number(req.header("content-length"));
      if (Number.isFinite(declared) && declared > cfg.liters.maxPushBytes) {
        return reject(req, res, 413, { error: "too_large", limit: cfg.liters.maxPushBytes });
      }
      try {
        // A push costs roughly twice its size in transit: the sink spools the body (unlinked, on the
        // volume — the sink points TMPDIR there precisely so this is counted) and then writes it
        // into the bucket. With no `content-length` — the reference client streams chunked — the
        // size term is zero and this degrades to "is there still headroom at all", which is the
        // question that actually matters on a volume that has been to zero.
        const bytes = Number.isFinite(declared) && declared > 0 ? declared * 2 : 0;
        requireSpaceFor(bytes, cfg, "liters push");
      } catch (e) {
        if (e instanceof IngestError) {
          return reject(req, res, e.status, { error: e.code, detail: e.message });
        }
        if (isVolumeError(e)) {
          return reject(req, res, 507, { error: "storage_unavailable", detail: storageFailureMessage(cfg, e) });
        }
        throw e;
      }
    }

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      headers[k] = v;
    }
    // The phone's credential stops here. The sink gets its own, and it is the only thing that can
    // reach a mount serving `DELETE /all`.
    headers.authorization = `Bearer ${cfg.liters.sinkToken}`;

    const upstream = http.request(
      { host, port, method: req.method, path: req.url, headers },
      (up) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (v === undefined || HOP_BY_HOP.has(k)) continue;
          out[k] = v;
        }
        // `x-liters-protocol` rides along in `out` and MUST: the reference client validates it on
        // every response, so that a proxy or a foreign server fails loudly instead of being
        // misparsed. Dropping it here would break every request while looking like a server bug.
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
        up.on("error", () => res.destroy());
      },
    );

    if (!isStream(req.url)) {
      // Loopback: anything not making progress for five minutes is wedged, not slow.
      upstream.setTimeout(300_000, () => upstream.destroy(new Error("liters sink timed out")));
    }

    upstream.on("error", async (e) => {
      // The sink is down, restarting, or was never enabled. 503 is honest and diagnosable.
      //
      // Known wrinkle, documented rather than papered over: liters' client maps any non-200 that is
      // not 401/403/404/409 to `StorageError::Other`, i.e. NOT transient — so the phone will not
      // fast-retry this. That costs one skipped sync, never data: `Writer::push()` runs again on the
      // next wake and pushes are idempotent by key. The alternative — destroying the socket so the
      // client sees a transport error and calls it transient — would trade a legible failure for an
      // invisible one, and this server has already paid for that trade once.
      await reject(req, res, 503, {
        error: "liters_sink_unavailable",
        detail: `the liters receive sidecar at ${cfg.liters.sinkAddr} is not answering (${e.message}). ` +
          "POST /ingest is unaffected and remains the fallback path for a full upload.",
      });
    });

    req.pipe(upstream);
    req.on("error", () => upstream.destroy());
    res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
  };
}

/**
 * The handler used when the liters path is switched off: a legible 503 rather than Express's bare
 * 404, so a phone pointed at a server that has not enabled the feature says so.
 */
export function litersDisabled(cfg: Config): express.RequestHandler {
  return async (req, res) => {
    // Authenticated first, like every other route: whether a feature exists on this server is not
    // something an unauthenticated caller gets to enumerate.
    if (tokenScope(cfg, req.header("authorization")) !== "rw") {
      return reject(req, res, 401, { error: "unauthorized" });
    }
    await drainBounded(req);
    if (res.headersSent) return;
    res.status(503).json({
      error: "liters_not_enabled",
      configured: false,
      feature: "liters",
      detail: "Page-level replication is switched off on this server (LITERS_SINK_ENABLED is unset). " +
        "This is a feature that has never been turned on, not a failure — POST /ingest is unaffected " +
        "and no data was lost. Retrying will keep returning this until the sink is enabled server-side.",
    });
  };
}
