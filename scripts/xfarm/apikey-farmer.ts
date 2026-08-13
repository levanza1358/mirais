#!/usr/bin/env bun
/**
 * xAI API Key Farmer — Node.js wrapper
 * Spawns Python script and returns parsed result.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ApiKeyFarmResult {
  success: boolean;
  email: string;
  api_key?: string;
  key_name?: string;
  error?: string;
}

export interface ApiKeyFarmOptions {
  email: string;
  password: string;
  headless?: boolean;
  timeout?: number;
}

export async function runApiKeyFarm(options: ApiKeyFarmOptions): Promise<ApiKeyFarmResult> {
  const scriptPath = path.join(__dirname, "apikey-farmer.py");
  const outputPath = path.join(__dirname, `apikey_result_${Date.now()}.json`);

  const args = [
    scriptPath,
    "--email", options.email,
    "--password", options.password,
    "--output", outputPath,
  ];

  if (options.headless !== false) {
    args.push("--headless");
  } else {
    args.push("--no-headless");
  }

  return new Promise((resolve) => {
    const proc = spawn("python", args, {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? 120_000,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      console.log("[APIKEY-FARM]", text.trim());
    });

    proc.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      console.error("[APIKEY-FARM ERROR]", text.trim());
    });

    proc.on("close", async (code) => {
      try {
        const fs = await import("node:fs/promises");
        const resultText = await fs.readFile(outputPath, "utf-8");
        await fs.unlink(outputPath).catch(() => {});
        const result = JSON.parse(resultText) as ApiKeyFarmResult;
        resolve(result);
      } catch (err) {
        resolve({
          success: false,
          email: options.email,
          error: `Failed to parse result: ${err}. stderr: ${stderr.slice(0, 500)}`,
        });
      }
    });

    proc.on("error", (err) => {
      resolve({
        success: false,
        email: options.email,
        error: `Failed to spawn Python: ${err.message}`,
      });
    });
  });
}

// CLI usage
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length < 4) {
    console.log("Usage: bun apikey-farmer.ts --email <email> --password <password> [--no-headless]");
    process.exit(1);
  }

  let email: string | undefined;
  let password: string | undefined;
  let headless = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--email" && args[i + 1]) {
      email = args[i + 1];
      i++;
    } else if (arg === "--password" && args[i + 1]) {
      password = args[i + 1];
      i++;
    } else if (arg === "--no-headless") {
      headless = false;
    }
  }

  if (!email || !password) {
    console.error("Missing --email or --password");
    process.exit(1);
  }

  console.log("Starting xAI API Key Farmer...");
  const result = await runApiKeyFarm({ email, password, headless });

  console.log("\n" + "=".repeat(60));
  if (result.success) {
    console.log(`✅ SUCCESS!`);
    console.log(`Email: ${result.email}`);
    console.log(`API Key: ${result.api_key}`);
    console.log(`Key Name: ${result.key_name}`);
  } else {
    console.log(`❌ FAILED: ${result.error}`);
  }
  console.log("=".repeat(60));

  process.exit(result.success ? 0 : 1);
}
