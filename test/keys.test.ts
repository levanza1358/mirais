import { describe, test, expect, beforeEach } from "bun:test";
import type { Database } from "../src/store/sql";
import { freshDb } from "./helpers";
import { KeysRepo } from "../src/store/repos/keys";
import { authenticateGatewayKey, authorizeModel } from "../src/auth";
import { isExpired, allowedModels, checkRateLimit, acquireSlot, releaseSlot } from "../src/ratelimit";
import { GatewayError } from "../src/shared/errors";

let db: Database;
let repo: KeysRepo;

beforeEach(async () => {
  db = await freshDb();
  repo = new KeysRepo(db);
});

describe("KeysRepo", () => {
  test("create returns plaintext once, stores plaintext + prefix", async () => {
    const { record, plaintext } = await repo.create({ label: "dev" });
    expect(plaintext.startsWith("mirais-")).toBe(true);
    expect(record.key_prefix).toBe(plaintext.slice(0, 12));
    expect(record.key_plain).toBe(plaintext);
    // legacy hash column still populated for backward compatibility
    expect(record.key_hash).toMatch(/^[0-9a-f]{64}$/);
    // list() exposes the plaintext column
    const listed = await repo.list();
    expect(listed[0]?.key_plain).toBe(plaintext);
  });

  test("getByPlaintextKey finds by plaintext (and legacy hash)", async () => {
    const { plaintext } = await repo.create({ label: "a" });
    expect((await repo.getByPlaintextKey(plaintext))?.label).toBe("a");
    expect(await repo.getByPlaintextKey("mirais-wrong")).toBeNull();
    // Legacy hash-only DBs still authenticate: clear the plaintext column,
    // lookup must fall back to the sha256 hash.
    const db2 = (repo as unknown as { db: Database }).db;
    await db2.query("UPDATE gateway_keys SET key_plain = NULL").run();
    expect((await repo.getByPlaintextKey(plaintext))?.label).toBe("a");
  });

  test("supports multiple independent keys with separate budgets", async () => {
    const first = await repo.create({ label: "app-a", dailyTokenBudget: 1000 });
    const second = await repo.create({ label: "app-b", dailyTokenBudget: 2500 });
    expect(await repo.list()).toHaveLength(2);
    expect((await repo.getByPlaintextKey(first.plaintext))?.daily_token_budget).toBe(1000);
    expect((await repo.getByPlaintextKey(second.plaintext))?.daily_token_budget).toBe(2500);
  });

  test("lifetime token budget permanently blocks the key after usage", async () => {
    const { record } = await repo.create({ label: "limited", tokenBudget: 100 });
    await db.query(`INSERT INTO request_logs (id, key_id, endpoint, requested_model, attempts, status, http_status, input_tokens, output_tokens, tokens_saved)
      VALUES ('usage-1', ?, '/v1/chat/completions', 'm', 1, 'success', 200, 60, 40, 0)`).run(record.id);
    expect((await checkRateLimit(db, record)).retryAfterSec).toBe(0);
  });

  test("update patches fields", async () => {
    const { record } = await repo.create({ label: "x" });
    const updated = await repo.update(record.id, { label: "y", enabled: false, rateLimitRpm: 10 });
    expect(updated?.label).toBe("y");
    expect(updated?.enabled).toBe(0);
    expect(updated?.rate_limit_rpm).toBe(10);
  });

  test("remove deletes", async () => {
    const { record } = await repo.create({ label: "gone" });
    await repo.remove(record.id);
    expect(await repo.get(record.id)).toBeNull();
  });
});

describe("authenticateGatewayKey", () => {
  test("missing header → 401", async () => {
    await expect(authenticateGatewayKey(db, null)).rejects.toBeInstanceOf(GatewayError);
    try { await authenticateGatewayKey(db, null); } catch (e) {
      expect((e as GatewayError).status).toBe(401);
    }
  });

  test("valid key authenticates and touches last_used", async () => {
    const { plaintext } = await repo.create({ label: "k" });
    const key = await authenticateGatewayKey(db, `Bearer ${plaintext}`);
    expect(key.label).toBe("k");
    expect((await repo.get(key.id))?.last_used_at).not.toBeNull();
  });

  test("disabled key rejected", async () => {
    const { record, plaintext } = await repo.create({ label: "k" });
    await repo.update(record.id, { enabled: false });
    try { await authenticateGatewayKey(db, `Bearer ${plaintext}`); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).status).toBe(401); }
  });

  test("expired key rejected", async () => {
    const { plaintext } = await repo.create({ label: "k", expiresAt: "2020-01-01T00:00:00Z" });
    try { await authenticateGatewayKey(db, `Bearer ${plaintext}`); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).message).toContain("expired"); }
  });
});

describe("authorizeModel", () => {
  test("null allowed_models → everything allowed", async () => {
    const { record } = await repo.create({ label: "k" });
    expect(() => authorizeModel(record, "anything")).not.toThrow();
  });

  test("restricts to listed models, supports *", async () => {
    const { record } = await repo.create({ label: "k", allowedModels: ["gpt-4o"] });
    expect(() => authorizeModel(record, "gpt-4o")).not.toThrow();
    try { authorizeModel(record, "claude"); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).status).toBe(403); }

    await repo.remove(record.id);
    const { record: star } = await repo.create({ label: "s", allowedModels: ["*"] });
    expect(() => authorizeModel(star, "whatever")).not.toThrow();
  });
});

describe("ratelimit helpers", () => {
  test("isExpired", async () => {
    const { record: future } = await repo.create({ label: "f", expiresAt: "2999-01-01T00:00:00Z" });
    await repo.remove(future.id);
    const { record: past } = await repo.create({ label: "p", expiresAt: "2000-01-01T00:00:00Z" });
    expect(isExpired(future)).toBe(false);
    expect(isExpired(past)).toBe(true);
  });

  test("allowedModels parses JSON", async () => {
    const { record } = await repo.create({ label: "k", allowedModels: ["a", "b"] });
    expect(allowedModels(record)).toEqual(["a", "b"]);
  });

  test("rpm limit kicks in", async () => {
    const { record } = await repo.create({ label: "k", rateLimitRpm: 2 });
    expect(await checkRateLimit(db, record)).toEqual({});
    expect(await checkRateLimit(db, record)).toEqual({});
    const third = await checkRateLimit(db, record);
    expect(third.retryAfterSec).toBeGreaterThan(0);
  });

  test("concurrency limit via slots", async () => {
    const { record } = await repo.create({ label: "k", concurrency: 1 });
    acquireSlot(record.id);
    const r = await checkRateLimit(db, record);
    expect(r.retryAfterSec).toBe(5);
    releaseSlot(record.id);
    expect(await checkRateLimit(db, record)).toEqual({});
  });
});
