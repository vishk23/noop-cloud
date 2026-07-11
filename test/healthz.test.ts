import { describe, it, expect } from "vitest";
import request from "node:http";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";

describe("scaffold", () => {
  it("loadConfig throws when RO_TOKEN missing", () => {
    const prev = process.env.RO_TOKEN;
    delete process.env.RO_TOKEN;
    expect(() => loadConfig()).toThrow(/RO_TOKEN/);
    if (prev !== undefined) process.env.RO_TOKEN = prev;
  });

  it("GET /healthz returns ok", async () => {
    process.env.RO_TOKEN = "ro-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    process.env.RW_TOKEN = "rw-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const app = createApp(loadConfig());
    const server = app.listen(0);
    const port = (server.address() as any).port;
    const body = await new Promise<string>((resolve, reject) => {
      request.get(`http://127.0.0.1:${port}/healthz`, (res) => {
        let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d));
      }).on("error", reject);
    });
    server.close();
    expect(JSON.parse(body)).toEqual({ ok: true });
  });
});
