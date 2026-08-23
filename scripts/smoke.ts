// Post-deploy smoke test: verifies the gateway is up and core surfaces respond.
// Usage: bun run smoke [baseUrl]
export {};

const base = process.argv[2] ?? `http://localhost:${process.env.PORT ?? 1463}`;

let failures = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(` FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function expectStatus(path: string, statuses: number[], init?: RequestInit) {
  const res = await fetch(`${base}${path}`, init);
  if (!statuses.includes(res.status)) {
    throw new Error(`GET ${path} → ${res.status}, expected ${statuses.join("/")}`);
  }
}

console.log(`Smoke testing ${base}\n`);

await check("GET /health → 200 + ok payload", async () => {
  const res = await fetch(`${base}/health`);
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as { status?: string };
  if (body.status !== "ok") throw new Error(`unexpected payload ${JSON.stringify(body)}`);
});

await check("GET /api/health → 200", () => expectStatus("/api/health", [200]));

await check("POST /v1/chat/completions without key → 401 OpenAI-shaped error", async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  if (res.status !== 401) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as { error?: { type?: string } };
  if (body.error?.type !== "authentication_error") throw new Error("error shape not OpenAI-style");
});

await check("GET /api/providers → 200 or 401 when a dashboard password is set", () => expectStatus("/api/providers", [200, 401]));

await check("GET / serves something (dashboard or placeholder)", () => expectStatus("/", [200]));

console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
