export function ulid(): string {
  // UUIDv7 — time-sortable, URL-safe, native via Bun
  return Bun.randomUUIDv7();
}

export function sha256Hex(input: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

export function randomApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "")
    .replaceAll("/", "")
    .replaceAll("=", "");
  return `mirais-${b64.slice(0, 32)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
