import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type XaiFarmLogLevel = "info" | "success" | "error";

export interface XaiFarmLogEntry {
  ts: string;
  level: XaiFarmLogLevel;
  message: string;
  email?: string;
}

const logFile = path.join(import.meta.dir, "..", "..", "data", "xai-farm.log.jsonl");
const MAX_ENTRIES = 200;

export async function writeXaiFarmLog(entry: Omit<XaiFarmLogEntry, "ts">): Promise<void> {
  await mkdir(path.dirname(logFile), { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  await appendFile(logFile, `${line}\n`, "utf8");
}

export async function readXaiFarmLogs(): Promise<XaiFarmLogEntry[]> {
  try {
    const content = await readFile(logFile, "utf8");
    return content
      .split("\n")
      .flatMap((line) => {
        try {
          return line ? [JSON.parse(line) as XaiFarmLogEntry] : [];
        } catch {
          return [];
        }
      })
      .slice(-MAX_ENTRIES)
      .reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function clearXaiFarmLogs(): Promise<void> {
  await mkdir(path.dirname(logFile), { recursive: true });
  await writeFile(logFile, "", "utf8");
}
