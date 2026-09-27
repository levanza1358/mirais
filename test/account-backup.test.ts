import { expect, test } from "bun:test";
import { exportAccountBackup, importAccountBackup } from "../src/admin/account-backup";
import { ProvidersRepo } from "../src/store/repos/providers";
import { freshDb } from "./helpers";

test("account backup restores credentials without other data", async () => {
  const source = new ProvidersRepo(await freshDb());
  const provider = await source.create({ name: "openai", type: "openai", accountStrategy: "round_robin" });
  const account = await source.addAccount(provider.id, { label: "main", apiKey: "secret", priority: 5 });
  await source.updateAccount(account.id, { enabled: false, sessionCookie: "cookie", notes: "note", tags: "tag", planType: "plus" });
  await source.updateAccountOAuth(account.id, {
    authKind: "oauth",
    refreshToken: "refresh",
    idToken: "id-token",
    accountId: "account-id",
    expiresAt: 123,
  });

  const backup = await exportAccountBackup(source);
  const target = new ProvidersRepo(await freshDb());
  const result = await importAccountBackup(target, backup);
  const restoredProvider = await target.getByName("openai");

  expect(result).toEqual({ imported: 1, skipped: 0 });
  expect(restoredProvider?.account_strategy).toBe("round_robin");
  const restored = (await target.listAccounts(restoredProvider!.id))[0]!;
  expect(restored).toMatchObject({
    label: "main",
    api_key: "secret",
    enabled: 0,
    auth_kind: "oauth",
    refresh_token: "refresh",
    id_token: "id-token",
    account_id: "account-id",
    expires_at: 123,
    session_cookie: "cookie",
    notes: "note",
    tags: "tag",
    plan_type: "plus",
  });
  expect(await importAccountBackup(target, backup)).toEqual({ imported: 0, skipped: 1 });
});
