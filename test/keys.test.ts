import { describe, test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { freshDb } from "./helpers";
import { KeysRepo } from "../src/store/repos/keys";
import { authenticateGatewayKey, authorizeModel } from "../src/auth";
import { isExpired, allowedModels, checkRateLimit, acquireSlot, releaseSlot } from "../src/ratelimit";
import { GatewayError } from "../src/shared/errors";

let db: Database;
let repo: KeysRepo;

beforeEach(() => {
  db = freshDb();
  repo = new KeysRepo(db);
});

describe("KeysRepo", () => {
  test("create returns plaintext once, stores plaintext + prefix", () => {
    const { record, plaintext } = repo.create({ label: "dev" });
    expect(plaintext.startsWith("mirais-")).toBe(true);
    expect(record.key_prefix).toBe(plaintext.slice(0, 12));
    expect(record.key_plain).toBe(plaintext);
    // legacy hash column still populated for backward compatibility
    expect(record.key_hash).toMatch(/^[0-9a-f]{64}$/);
    // list() exposes the plaintext column
    const listed = repo.list();
    expect(listed[0]?.key_plain).toBe(plaintext);
  });

  test("getByPlaintextKey finds by plaintext (and legacy hash)", () => {
    const { plaintext } = repo.create({ label: "a" });
    expect(repo.getByPlaintextKey(plaintext)?.label).toBe("a");
    expect(repo.getByPlaintextKey("mirais-wrong")).toBeNull();
    // Legacy hash-only DBs still authenticate: clear the plaintext column,
    // lookup must fall back to the sha256 hash.
    const db2 = (repo as unknown as { db: import("bun:sqlite").Database }).db;
    db2.query("UPDATE gateway_keys SET key_plain = NULL").run();
    expect(repo.getByPlaintextKey(plaintext)?.label).toBe("a");
  });

  test("update patches fields", () => {
    const { record } = repo.create({ label: "x" });
    const updated = repo.update(record.id, { label: "y", enabled: false, rateLimitRpm: 10 });
    expect(updated?.label).toBe("y");
    expect(updated?.enabled).toBe(0);
    expect(updated?.rate_limit_rpm).toBe(10);
  });

  test("remove deletes", () => {
    const { record } = repo.create({ label: "gone" });
    repo.remove(record.id);
    expect(repo.get(record.id)).toBeNull();
  });
});

describe("authenticateGatewayKey", () => {
  test("missing header → 401", () => {
    expect(() => authenticateGatewayKey(db, null)).toThrow(GatewayError);
    try { authenticateGatewayKey(db, null); } catch (e) {
      expect((e as GatewayError).status).toBe(401);
    }
  });

  test("valid key authenticates and touches last_used", () => {
    const { plaintext } = repo.create({ label: "k" });
    const key = authenticateGatewayKey(db, `Bearer ${plaintext}`);
    expect(key.label).toBe("k");
    expect(repo.get(key.id)?.last_used_at).not.toBeNull();
  });

  test("disabled key rejected", () => {
    const { record, plaintext } = repo.create({ label: "k" });
    repo.update(record.id, { enabled: false });
    try { authenticateGatewayKey(db, `Bearer ${plaintext}`); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).status).toBe(401); }
  });

  test("expired key rejected", () => {
    const { plaintext } = repo.create({ label: "k", expiresAt: "2020-01-01T00:00:00Z" });
    try { authenticateGatewayKey(db, `Bearer ${plaintext}`); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).message).toContain("expired"); }
  });
});

describe("authorizeModel", () => {
  test("null allowed_models → everything allowed", () => {
    const { record } = repo.create({ label: "k" });
    expect(() => authorizeModel(record, "anything")).not.toThrow();
  });

  test("restricts to listed models, supports *", () => {
    const { record } = repo.create({ label: "k", allowedModels: ["gpt-4o"] });
    expect(() => authorizeModel(record, "gpt-4o")).not.toThrow();
    try { authorizeModel(record, "claude"); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).status).toBe(403); }

    repo.remove(record.id);
    const { record: star } = repo.create({ label: "s", allowedModels: ["*"] });
    expect(() => authorizeModel(star, "whatever")).not.toThrow();
  });
});

describe("ratelimit helpers", () => {
  test("isExpired", () => {
    const { record: future } = repo.create({ label: "f", expiresAt: "2999-01-01T00:00:00Z" });
    repo.remove(future.id);
    const { record: past } = repo.create({ label: "p", expiresAt: "2000-01-01T00:00:00Z" });
    expect(isExpired(future)).toBe(false);
    expect(isExpired(past)).toBe(true);
  });

  test("allowedModels parses JSON", () => {
    const { record } = repo.create({ label: "k", allowedModels: ["a", "b"] });
    expect(allowedModels(record)).toEqual(["a", "b"]);
  });

  test("rpm limit kicks in", () => {
    const { record } = repo.create({ label: "k", rateLimitRpm: 2 });
    expect(checkRateLimit(db, record)).toEqual({});
    expect(checkRateLimit(db, record)).toEqual({});
    const third = checkRateLimit(db, record);
    expect(third.retryAfterSec).toBeGreaterThan(0);
  });

  test("concurrency limit via slots", () => {
    const { record } = repo.create({ label: "k", concurrency: 1 });
    acquireSlot(record.id);
    const r = checkRateLimit(db, record);
    expect(r.retryAfterSec).toBe(5);
    releaseSlot(record.id);
    expect(checkRateLimit(db, record)).toEqual({});
  });
});
