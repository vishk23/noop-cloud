import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  mirrorPath: string;
  serverDbPath: string;
  roToken: string;
  rwToken: string;
  maxIngestBytes: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length < 16) throw new Error(`${name} must be set (>=16 chars)`);
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
  };
}
