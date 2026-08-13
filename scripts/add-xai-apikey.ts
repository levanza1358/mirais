#!/usr/bin/env bun
/**
 * Add xAI API key accounts to Mirais.
 *
 * Usage:
 *   bun scripts/add-xai-apikey.ts <api-key-1> [api-key-2] [api-key-3] ...
 *   bun scripts/add-xai-apikey.ts --label "My Account" <api-key>
 *
 * API keys can be created at: https://console.x.ai
 * They look like: xai-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 */

import { ProvidersRepo } from "../src/store/repos/providers";
import { getDb } from "../src/store/db";
import { config } from "../src/config";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log("Usage: bun scripts/add-xai-apikey.ts <api-key-1> [api-key-2] ...");
  console.log("       bun scripts/add-xai-apikey.ts --label \"Name\" <api-key>");
  console.log("");
  console.log("Get your API key from: https://console.x.ai");
  process.exit(1);
}

// Parse args
let label: string | undefined;
const apiKeys: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!arg) continue;
  if (arg === "--label" && args[i + 1]) {
    label = args[i + 1];
    i++;
  } else if (arg.startsWith("xai-") || arg.length > 20) {
    apiKeys.push(arg);
  } else {
    console.error(`Warning: "${arg}" doesn't look like an xAI API key (should start with "xai-")`);
  }
}

if (apiKeys.length === 0) {
  console.error("No valid API keys provided");
  process.exit(1);
}

const db = getDb(config.dbPath);
const repo = new ProvidersRepo(db);

// Find xAI provider
const providers = repo.list();
const xaiProvider = providers.find((p) => p.type === "xai");

if (!xaiProvider) {
  console.error("No xAI provider found. Create one first in the dashboard.");
  process.exit(1);
}

console.log(`Found xAI provider: ${xaiProvider.name} (${xaiProvider.id})`);
console.log(`Adding ${apiKeys.length} API key account(s)...\n`);

let added = 0;
let skipped = 0;

for (const apiKey of apiKeys) {
  // Check if already exists
  const existing = repo.listAccounts(xaiProvider.id).find((a) => a.api_key === apiKey);
  if (existing) {
    console.log(`⏭️  Skipped: ${apiKey.slice(0, 12)}... (already exists as "${existing.label}")`);
    skipped++;
    continue;
  }

  const accountLabel = label ?? `apikey-${apiKey.slice(-6)}`;
  const account = repo.addAccount(xaiProvider.id, {
    label: accountLabel,
    apiKey,
    priority: 0,
  });

  console.log(`✅ Added: ${accountLabel} (${apiKey.slice(0, 12)}...)`);
  added++;
}

console.log(`\nDone: ${added} added, ${skipped} skipped`);
console.log("\n⚠️  Note: These accounts use the API key endpoint (api.x.ai), not the OAuth CLI endpoint.");
console.log("   They are NOT affected by the Grok CLI 426 version enforcement.");
console.log("   However, they consume API credits from your xAI account.");

db.close();
