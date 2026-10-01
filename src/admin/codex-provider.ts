import type { ProviderAccount } from "../shared/types";
import type { ProvidersRepo } from "../store/repos/providers";
import { codexHeaders, codexRequestBody, codexUrl, consumeCodexResetCredit, ensureFreshToken, fetchCodexModels, fetchCodexResetCredits, fetchCodexUsage, isCodexQuotaExhausted } from "../proxy/codex";
import { ulid as newRedeemId } from "../utils/id";

/** Provider-specific OAuth operations for OpenAI Codex accounts. */
export async function fetchCodexProviderModels(repo: ProvidersRepo, account: ProviderAccount) {
  const accessToken = await ensureFreshToken(repo, account);
  return fetchCodexModels(account, accessToken);
}

export async function checkCodexProviderQuota(repo: ProvidersRepo, account: ProviderAccount) {
  const accessToken = await ensureFreshToken(repo, account);
  const usage = await fetchCodexUsage(account, accessToken);
  return { usage, exhausted: isCodexQuotaExhausted(usage) };
}

/**
 * Pull the per-credit reset inventory for an OAuth Codex account. Returns
 * `{ available_count: 0, credits: [] }` for accounts the Codex backend
 * doesn't expose reset credits for (e.g. free plans).
 */
export async function fetchCodexProviderResetCredits(repo: ProvidersRepo, account: ProviderAccount) {
  const accessToken = await ensureFreshToken(repo, account);
  return fetchCodexResetCredits(account, accessToken);
}

/**
 * Spend one reset credit on behalf of the operator. Caller is expected to
 * have generated a `redeemRequestId` so the upstream can dedupe replays.
 */
export async function consumeCodexProviderResetCredit(
  repo: ProvidersRepo,
  account: ProviderAccount,
  redeemRequestId?: string,
) {
  const accessToken = await ensureFreshToken(repo, account);
  return consumeCodexResetCredit(account, accessToken, redeemRequestId ?? newRedeemId());
}

export async function testCodexProviderModel(
  repo: ProvidersRepo,
  account: ProviderAccount,
  model: string,
  prompt: string,
): Promise<Response> {
  const accessToken = await ensureFreshToken(repo, account);
  return fetch(codexUrl("/responses"), {
    method: "POST",
    headers: codexHeaders(account, accessToken, true),
    body: JSON.stringify(codexRequestBody({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    }, model, true)),
    signal: AbortSignal.timeout(30_000),
  });
}
