import type { ProviderAccount } from "../shared/types";
import type { ProvidersRepo } from "../store/repos/providers";
import { codexHeaders, codexRequestBody, codexUrl, ensureFreshToken, fetchCodexModels, fetchCodexUsage, isCodexQuotaExhausted } from "../proxy/codex";

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
