import { describe, it, expect } from "vitest";
import express from "express";
import http from "node:http";
import { requireScope } from "../src/auth.js";

const cfg = { roToken: "ro".padEnd(40, "x"), rwToken: "rw".padEnd(40, "y") } as any;

function call(handlerScope: "ro" | "rw", header?: string): Promise<number> {
  const app = express();
  app.get("/p", requireScope(cfg, handlerScope), (_r, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const port = (server.address() as any).port;
  return new Promise((resolve) => {
    http.get({ port, path: "/p", headers: header ? { authorization: header } : {} }, (res) => {
      server.close(); resolve(res.statusCode!);
    });
  });
}

describe("requireScope", () => {
  it("401 with no header", async () => expect(await call("ro")).toBe(401));
  it("401 with wrong token", async () => expect(await call("ro", "Bearer nope")).toBe(401));
  it("ro token satisfies ro scope", async () => expect(await call("ro", `Bearer ${cfg.roToken}`)).toBe(200));
  it("rw token satisfies ro scope", async () => expect(await call("ro", `Bearer ${cfg.rwToken}`)).toBe(200));
  it("ro token does NOT satisfy rw scope", async () => expect(await call("rw", `Bearer ${cfg.roToken}`)).toBe(401));
  it("rw token satisfies rw scope", async () => expect(await call("rw", `Bearer ${cfg.rwToken}`)).toBe(200));
});
