import { z } from "zod";
import path from "node:path";
import fs from "node:fs";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(1463),
  HOST: z.string().default("0.0.0.0"),
  DATA_DIR: z.string().default("./data"),
  TOKEN_SAVER: z.enum(["on", "off"]).default("on"),
  TRACK_PAYLOADS: z.enum(["none", "meta", "full"]).default("meta"),
  REQUEST_BODY_LIMIT_MB: z.coerce.number().positive().default(25),
  // Server-level cap for file uploads (backup restore). Bun rejects larger
  // request bodies with 413 before any route runs.
  MAX_UPLOAD_MB: z.coerce.number().positive().default(1024),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().positive().default(120000),
  // The ChatGPT Codex model catalog is gated by this official CLI version.
  // Override it after updating Codex CLI if its catalog includes newer models.
  CODEX_CLIENT_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/, "must be a semantic version").default("0.145.0"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // When `true` (default), every /v1/* request must carry a valid gateway
  // key. Set `MIRAIS_AUTH_REQUIRED=false` to allow anonymous proxy use when
  // the operator is confident the listener is only reachable from a trusted
  // network (loopback bind, reverse proxy, VPN, private network).
  MIRAIS_AUTH_REQUIRED: z.enum(["on", "off"]).default("on"),
  // Optional dashboard password. When set (or once a password is saved from
  // the dashboard), every /api/* route except /api/auth/* and /api/health
  // requires a session cookie.
  DASHBOARD_PASSWORD: z.string().min(8).optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().max(24 * 365).default(12),
});

const parsed = envSchema.parse(process.env);

const dataDir = path.resolve(parsed.DATA_DIR);
// Guard: relative paths like `./data` resolve against process.cwd(), which
// silently becomes `/data` (root) or `/home/...` depending on how the
// process was launched. A data directory under a system directory or under
// the current user's home is almost certainly not what the operator meant.
// We log a loud warning at startup so the symptom ("VPS shows empty data,
// looks unauthenticated") shows up in `mirais.log` before it shows up in
// the dashboard.
if (process.platform !== "win32" && dataDir === "/data") {
  // eslint-disable-next-line no-console
  console.warn(
    `[mirais] WARNING: DATA_DIR resolved to "/data". On Linux, "./data" expands to ` +
      `the process working directory at startup. If Mirais is started by systemd without ` +
      `WorkingDirectory set (or with a different one), the SQLite file lands in /data ` +
      `and the dashboard sees an empty database. Set DATA_DIR to an absolute path ` +
      `(for example /opt/mirais/data) in your environment or .env file.`,
  );
}
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, "backups"), { recursive: true });

export const config = {
  port: parsed.PORT,
  host: parsed.HOST,
  dataDir,
  dbPath: path.join(dataDir, "mirais.db"),
  tokenSaverDefault: parsed.TOKEN_SAVER === "on",
  trackPayloads: parsed.TRACK_PAYLOADS,
  requestBodyLimit: parsed.REQUEST_BODY_LIMIT_MB * 1024 * 1024,
  maxUploadBytes: parsed.MAX_UPLOAD_MB * 1024 * 1024,
  upstreamTimeoutMs: parsed.UPSTREAM_TIMEOUT_MS,
  codexClientVersion: parsed.CODEX_CLIENT_VERSION,
  logLevel: parsed.LOG_LEVEL,
  authRequired: parsed.MIRAIS_AUTH_REQUIRED === "on",
  dashboardPassword: parsed.DASHBOARD_PASSWORD,
  sessionTtlHours: parsed.SESSION_TTL_HOURS,
  version: "1.0.4",
  startedAt: Date.now(),
} as const;

export type Config = typeof config;
