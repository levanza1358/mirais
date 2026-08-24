import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

export async function gzipFile(source: string, destination: string): Promise<void> {
  await pipeline(fs.createReadStream(source), createGzip(), fs.createWriteStream(destination));
}

export async function gunzipFile(source: string, destination: string): Promise<void> {
  await pipeline(fs.createReadStream(source), createGunzip(), fs.createWriteStream(destination));
}

export function isSqliteFile(file: string): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(16);
    return fs.readSync(fd, header, 0, header.length, 0) === header.length
      && header.toString("ascii") === "SQLite format 3\0";
  } finally {
    fs.closeSync(fd);
  }
}