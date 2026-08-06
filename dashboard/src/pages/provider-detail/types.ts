import type { Provider, ProviderAccount } from "../../api";

export const TYPES = ["openai", "anthropic", "deepseek", "xai", "glm", "blackbox", "codebuddy-global", "codebuddy-cn", "custom"] as const;
export const DEFAULT_ACCOUNTS_PER_PAGE = 10;
export const ACCOUNT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

export type ModelTestResult = {
  ok: boolean;
  latency_ms: number;
  detail?: string;
  preview_text?: string;
  context_length?: number | null;
  max_output_tokens?: number | null;
  capabilities?: string[];
  testing?: boolean;
};

export type ProviderModalProps = {
  provider: Provider;
  onClose: () => void;
};

export type ProviderAccountModalProps = {
  account: ProviderAccount;
  onClose: () => void;
};
