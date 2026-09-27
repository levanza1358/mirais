import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SQL } from "bun";
import { log } from "../utils/logger";

const MYSQL_VERSION = "8.4.11";
const DATABASE_NAME = "mirais";
const DATABASE_USER = "mirais";
const MYSQL_ARCHIVE_MARKER = ".complete";

const credentialsSchema = z.object({
  version: z.literal(1),
  port: z.number().int().min(1).max(65535),
  database: z.literal(DATABASE_NAME),
  username: z.literal(DATABASE_USER),
  password: z.string().min(32),
});

export type MySqlCredentials = z.infer<typeof credentialsSchema>;

interface ServerPaths {
  root: string;
  data: string;
  server: string;
  config: string;
  credentials: string;
  log: string;
}

function serverPaths(root: string): ServerPaths {
  return {
    root,
    data: path.join(root, "data"),
    server: path.join(root, "server"),
    config: path.join(root, process.platform === "win32" ? "my.ini" : "my.cnf"),
    credentials: path.join(root, "credentials.json"),
    log: path.join(root, "mysql.log"),
  };
}

function mysqlExecutable(serverRoot: string): { basedir: string; executable: string } | null {
  const executableName = process.platform === "win32" ? "mysqld.exe" : "mysqld";
  if (!fs.existsSync(serverRoot)) return null;
  if (fs.existsSync(path.join(serverRoot, "bin", executableName))) {
    return { basedir: serverRoot, executable: path.join(serverRoot, "bin", executableName) };
  }
  for (const entry of fs.readdirSync(serverRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const basedir = path.join(serverRoot, entry.name);
    const executable = path.join(basedir, "bin", executableName);
    if (fs.existsSync(executable)) return { basedir, executable };
  }
  return null;
}

function mysqlInstallComplete(serverRoot: string): boolean {
  const installed = mysqlExecutable(serverRoot);
  if (!installed) return false;
  if (process.platform !== "win32") return true;
  return fs.existsSync(path.join(installed.basedir, "lib", "plugin", "component_reference_cache.dll"));
}

function archiveForPlatform(): { filename: string; url: string } {
  if (process.platform === "win32" && process.arch === "x64") {
    const filename = `mysql-${MYSQL_VERSION}-winx64.zip`;
    return { filename, url: `https://dev.mysql.com/get/Downloads/MySQL-8.4/${filename}` };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    const filename = `mysql-${MYSQL_VERSION}-linux-glibc2.28-x86_64-minimal.tar.xz`;
    return { filename, url: `https://dev.mysql.com/get/Downloads/MySQL-8.4/${filename}` };
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    const filename = `mysql-${MYSQL_VERSION}-linux-glibc2.28-aarch64-minimal.tar.xz`;
    return { filename, url: `https://dev.mysql.com/get/Downloads/MySQL-8.4/${filename}` };
  }
  throw new Error(`Portable MySQL ${MYSQL_VERSION} is not packaged for ${process.platform}/${process.arch}`);
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with code ${code ?? 1}: ${stderr.trim().slice(-1500)}`));
    });
  });
}

async function installServer(paths: ServerPaths): Promise<{ basedir: string; executable: string }> {
  const installed = mysqlExecutable(paths.server);
  const marker = path.join(paths.server, MYSQL_ARCHIVE_MARKER);
  if (installed && fs.existsSync(marker) && mysqlInstallComplete(paths.server)) return installed;
  if (installed && !mysqlInstallComplete(paths.server)) fs.rmSync(paths.server, { recursive: true, force: true });

  fs.mkdirSync(paths.server, { recursive: true });
  const archive = archiveForPlatform();
  const archivePath = path.join(paths.root, archive.filename);
  const response = await fetch(archive.url, { signal: AbortSignal.timeout(15 * 60_000), redirect: "follow" });
  if (!response.ok) throw new Error(`MySQL download failed with HTTP ${response.status}`);
  await Bun.write(archivePath, response);
  try {
    await run("tar", ["-xf", archivePath, "-C", paths.server], paths.root);
  } finally {
    fs.rmSync(archivePath, { force: true });
  }

  const result = mysqlExecutable(paths.server);
  if (!result) throw new Error("Downloaded MySQL archive did not contain mysqld");
  if (!mysqlInstallComplete(paths.server)) throw new Error("Downloaded MySQL archive is incomplete");
  fs.writeFileSync(marker, `${MYSQL_VERSION}\n`);
  return result;
}

function writeServerConfig(paths: ServerPaths, basedir: string, port: number): void {
  const mysqlPath = (value: string) => path.resolve(value).replaceAll("\\", "/");
  const contents = [
    "[mysqld]",
    `basedir=${mysqlPath(basedir)}`,
    `datadir=${mysqlPath(paths.data)}`,
    `port=${port}`,
    "bind-address=127.0.0.1",
    "mysqlx=0",
    "mysql_native_password=ON",
    "character-set-server=utf8mb4",
    "collation-server=utf8mb4_bin",
    `pid-file=${mysqlPath(path.join(paths.root, "mysqld.pid"))}`,
    `log-error=${mysqlPath(paths.log)}`,
    "",
  ].join("\n");
  fs.writeFileSync(paths.config, contents, { mode: 0o600 });
}

function loadCredentials(paths: ServerPaths, port: number): MySqlCredentials | null {
  if (!fs.existsSync(paths.credentials)) return null;
  const parsed = credentialsSchema.safeParse(JSON.parse(fs.readFileSync(paths.credentials, "utf8")) as unknown);
  if (!parsed.success) throw new Error("Portable MySQL credentials file is invalid");
  if (parsed.data.port !== port) throw new Error(`Portable MySQL is already configured on port ${parsed.data.port}`);
  return parsed.data;
}

function saveCredentials(paths: ServerPaths, port: number): MySqlCredentials {
  const credentials: MySqlCredentials = {
    version: 1,
    port,
    database: DATABASE_NAME,
    username: DATABASE_USER,
    password: crypto.randomBytes(32).toString("base64url"),
  };
  fs.writeFileSync(paths.credentials, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  return credentials;
}

async function connect(credentials: MySqlCredentials): Promise<SQL> {
  const client = new SQL({
    adapter: "mysql",
    hostname: "127.0.0.1",
    port: credentials.port,
    database: credentials.database,
    username: credentials.username,
    password: credentials.password,
    max: 1,
    connectionTimeout: 3,
  });
  await client`SELECT 1`;
  return client;
}

async function initializeDatabase(credentials: MySqlCredentials): Promise<void> {
  const root = new SQL({
    adapter: "mysql",
    hostname: "127.0.0.1",
    port: credentials.port,
    database: "mysql",
    username: "root",
    password: "",
    max: 1,
    connectionTimeout: 3,
  });
  try {
    await root`CREATE DATABASE IF NOT EXISTS mirais CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`;
    const password = credentials.password.replaceAll("'", "''");
    await root.unsafe(`CREATE USER IF NOT EXISTS 'mirais'@'127.0.0.1' IDENTIFIED BY '${password}'`);
    await root.unsafe(`ALTER USER 'mirais'@'127.0.0.1' IDENTIFIED BY '${password}'`);
    await root`GRANT ALL PRIVILEGES ON mirais.* TO 'mirais'@'127.0.0.1'`;
  } finally {
    await root.close();
  }
}

async function waitForServer(credentials: MySqlCredentials): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const client = new SQL({
        adapter: "mysql",
        hostname: "127.0.0.1",
        port: credentials.port,
        database: "mysql",
        username: "root",
        password: "",
        max: 1,
        connectionTimeout: 2,
      });
      await client`SELECT 1`;
      await client.close();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Portable MySQL did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function startServer(paths: ServerPaths, executable: string): void {
  const logFd = fs.openSync(paths.log, "a");
  try {
    const child = spawn(executable, [`--defaults-file=${paths.config}`], {
      cwd: path.dirname(path.dirname(executable)),
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    child.once("error", (error) => {
      // The readiness loop reports startup failures to the caller.
      log.error("portable MySQL process failed", { error: error.message });
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
}

export async function ensurePortableMySql(root: string, port: number): Promise<MySqlCredentials> {
  const paths = serverPaths(path.resolve(root));
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.data, { recursive: true, mode: 0o700 });

  let credentials = loadCredentials(paths, port);
  const server = await installServer(paths);
  writeServerConfig(paths, server.basedir, port);

  if (!fs.existsSync(path.join(paths.data, "mysql"))) {
    await run(server.executable, [
      `--defaults-file=${paths.config}`,
      "--initialize-insecure",
      "--console",
    ], server.basedir);
    credentials ??= saveCredentials(paths, port);
    startServer(paths, server.executable);
    await waitForServer(credentials);
    await initializeDatabase(credentials);
  } else {
    credentials ??= saveCredentials(paths, port);
    try {
      const existing = await connect(credentials);
      await existing.close();
      return credentials;
    } catch {
      startServer(paths, server.executable);
      await waitForServer(credentials);
      await initializeDatabase(credentials);
    }
  }

  const verified = await connect(credentials);
  await verified.close();
  return credentials;
}