import type { z } from "zod";
import { accountBackupSchema } from "../shared/schemas";
import type { ProvidersRepo } from "../store/repos/providers";

export type AccountBackup = z.infer<typeof accountBackupSchema>;

export async function exportAccountBackup(repo: ProvidersRepo): Promise<AccountBackup> {
  const providers = await repo.list();
  const backupProviders: AccountBackup["providers"] = [];
  for (const provider of providers) {
    const accounts = await repo.listAccounts(provider.id);
    backupProviders.push({
      name: provider.name,
      type: provider.type,
      base_url: provider.base_url,
      enabled: Boolean(provider.enabled),
      priority: provider.priority,
      account_strategy: provider.account_strategy,
      accounts: accounts.map((account) => ({
        label: account.label,
        api_key: account.api_key,
        base_url: account.base_url ?? null,
        enabled: Boolean(account.enabled),
        priority: account.priority,
        auth_kind: account.auth_kind ?? "api_key",
        account_kind: account.account_kind ?? null,
        refresh_token: account.refresh_token ?? null,
        id_token: account.id_token ?? null,
        account_id: account.account_id ?? null,
        plan_type: account.plan_type ?? null,
        expires_at: account.expires_at ?? null,
        notes: account.notes ?? null,
        tags: account.tags ?? null,
        session_cookie: account.session_cookie ?? null,
      })),
    });
  }
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    providers: backupProviders,
  };
}

export async function importAccountBackup(repo: ProvidersRepo, backup: AccountBackup): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const source of backup.providers) {
    let provider = await repo.getByName(source.name);
    if (provider && provider.type !== source.type) throw new Error(`Provider '${source.name}' has a different type`);
    if (!provider) {
      provider = await repo.create({
        name: source.name,
        type: source.type,
        baseUrl: source.base_url,
        enabled: source.enabled,
        priority: source.priority,
        accountStrategy: source.account_strategy,
      });
    }

    const existing = await repo.listAccounts(provider.id);
    for (const sourceAccount of source.accounts) {
      const duplicate = existing.some((account) => sourceAccount.api_key
        ? account.api_key === sourceAccount.api_key
        : account.label === sourceAccount.label);
      if (duplicate) {
        skipped += 1;
        continue;
      }

      const account = await repo.addAccount(provider.id, {
        label: sourceAccount.label,
        apiKey: sourceAccount.api_key,
        baseUrl: sourceAccount.base_url,
        priority: sourceAccount.priority,
        accountKind: sourceAccount.account_kind ?? null,
      });
      await repo.updateAccount(account.id, {
        enabled: sourceAccount.enabled,
        notes: sourceAccount.notes,
        tags: sourceAccount.tags,
        sessionCookie: sourceAccount.session_cookie,
        planType: sourceAccount.plan_type,
      });
      await repo.updateAccountOAuth(account.id, {
        authKind: sourceAccount.auth_kind,
        refreshToken: sourceAccount.refresh_token,
        idToken: sourceAccount.id_token,
        accountId: sourceAccount.account_id,
        expiresAt: sourceAccount.expires_at,
      });
      const created = await repo.getAccount(account.id);
      if (created) existing.push(created);
      imported += 1;
    }
  }

  return { imported, skipped };
}
