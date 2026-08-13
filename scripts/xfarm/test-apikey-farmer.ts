#!/usr/bin/env bun
/**
 * Test script for xAI API Key Farmer
 * Usage: bun scripts/xfarm/test-apikey-farmer.ts <email> <password>
 */

import { runApiKeyFarm } from "./apikey-farmer";

const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.log("Usage: bun scripts/xfarm/test-apikey-farmer.ts <email> <password>");
  console.log("\nExample:");
  console.log('  bun scripts/xfarm/test-apikey-farmer.ts "user@example.com" "mypassword"');
  process.exit(1);
}

console.log("=".repeat(60));
console.log("Testing xAI API Key Farmer");
console.log("=".repeat(60));
console.log(`Email: ${email}`);
console.log("Mode: Headless (set --no-headless to see browser)");
console.log("=".repeat(60));
console.log("\nStarting...\n");

const result = await runApiKeyFarm({
  email,
  password,
  headless: true,
  timeout: 180_000, // 3 minutes
});

console.log("\n" + "=".repeat(60));
console.log("RESULT:");
console.log("=".repeat(60));
console.log(JSON.stringify(result, null, 2));
console.log("=".repeat(60));

if (result.success) {
  console.log("\n✅ SUCCESS! You can now add this API key to Mirais:");
  console.log(`\nbun scripts/add-xai-apikey.ts "${result.api_key}"`);
} else {
  console.log("\n❌ FAILED");
  console.log("Check the debug screenshots:");
  console.log("  - debug_apikeys.png");
  console.log("  - debug_key_extract.png");
  console.log("  - debug_error.png");
  process.exit(1);
}
