import { z } from "zod";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(1463),
  HOST: z.string().default("127.0.0.1"),
  DATA_DIR: z.string().default("./data"),
  DASHBOARD_PASSWORD: z.string().default(""),
  SESSION_SECRET: z.string().default(""),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  TOKEN_SAVER: z.enum(["on", "off"]).default("on"),
  TRACK_PAYLOADS: z.enum(["none", "meta", "full"]).default("meta"),
  REQUEST_BODY_LIMIT_MB: z.coerce.number().positive().default(25),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().positive().default(120000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const parsed = envSchema.parse(process.env);

const dataDir = path.resolve(parsed.DATA_DIR);
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, "backups"), { recursive: true });

// Generate ephemeral session secret when not configured (dev convenience).
// Sessions won't survive restart in that case — documented behavior.
const sessionSecret =
  parsed.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

export const config = {
  port: parsed.PORT,
  host: parsed.HOST,
  dataDir,
  dbPath: path.join(dataDir, "mirais.db"),
  dashboardPassword: parsed.DASHBOARD_PASSWORD,
  sessionSecret,
  sessionTtlHours: parsed.SESSION_TTL_HOURS,
  tokenSaverDefault: parsed.TOKEN_SAVER === "on",
  trackPayloads: parsed.TRACK_PAYLOADS,
  requestBodyLimit: parsed.REQUEST_BODY_LIMIT_MB * 1024 * 1024,
  upstreamTimeoutMs: parsed.UPSTREAM_TIMEOUT_MS,
  logLevel: parsed.LOG_LEVEL,
  version: "1.0.0",
  startedAt: Date.now(),
} as const;

export type Config = typeof config;
