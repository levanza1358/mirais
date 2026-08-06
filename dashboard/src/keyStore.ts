// Local plaintext key store.
//
// The server stores gateway keys hashed (SHA-256) and can never return the
// plaintext again. Since this dashboard is a local, single-user,
// password-protected app, we keep the plaintext in localStorage so the key
// stays visible and copyable across sessions. Keyed by key_prefix so multiple
// keys can be remembered.

const KEY_STORAGE = "mirais.gatewayKey";

function readMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY_STORAGE) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function storedKeyFor(prefix: string): string | null {
  return readMap()[prefix] ?? null;
}

export function rememberKey(prefix: string, plaintext: string): void {
  try {
    const map = readMap();
    map[prefix] = plaintext;
    localStorage.setItem(KEY_STORAGE, JSON.stringify(map));
  } catch {
    /* storage full/blocked — non-fatal */
  }
}

export function forgetKey(prefix: string): void {
  try {
    const map = readMap();
    delete map[prefix];
    localStorage.setItem(KEY_STORAGE, JSON.stringify(map));
  } catch {
    /* non-fatal */
  }
}
