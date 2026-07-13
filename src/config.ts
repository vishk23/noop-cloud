import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  mirrorPath: string;
  serverDbPath: string;
  roToken: string;
  rwToken: string;
  maxIngestBytes: number;
  // Push-triggered on-demand sync (request_sync MCP tool + POST /register-device). All four
  // optional together: unset means the tool responds {configured:false} instead of failing.
  apnsKeyP8?: string;
  apnsKeyId?: string;
  appleTeamId?: string;
  apnsTopic?: string;
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
    maxIngestBytes: Number(process.env.MAX_INGEST_BYTES ?? 262_144_000),
    apnsKeyP8: process.env.APNS_KEY_P8,
    apnsKeyId: process.env.APNS_KEY_ID,
    appleTeamId: process.env.APPLE_TEAM_ID,
    apnsTopic: process.env.APNS_TOPIC,
  };
}
