// Static catalog of well-known providers shown as cards on the Providers page.
// Clicking a card opens the provider's account page; if the provider doesn't
// exist yet it is created on the fly with these defaults.

import anthropicIcon from "./assets/provider-icons/anthropic.svg";
import blackboxIcon from "./assets/provider-icons/blackbox.png";
import codebuddyIcon from "./assets/provider-icons/codebuddy.svg";
import deepseekIcon from "./assets/provider-icons/deepseek.svg";
import openaiIcon from "./assets/provider-icons/openai.svg";

export interface ProviderPreset {
  /** Provider `type` stored in the DB. */
  type: string;
  /** Suggested provider name when auto-creating. */
  name: string;
  displayName: string;
  description: string;
  /** Two-letter fallback shown in the icon tile. */
  textIcon: string;
  iconSrc?: string;
  color: string;
  /** Where to obtain an API key. */
  credentialUrl?: string;
  /** Default base URL (undefined = server default for the type). */
  baseUrl?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    type: "openai",
    name: "openai",
    displayName: "OpenAI (Codex)",
    description: "GPT models & Codex via the OpenAI API",
    textIcon: "OA",
    iconSrc: openaiIcon,
    color: "#FFFFFF",
    credentialUrl: "https://platform.openai.com/api-keys",
  },
  {
    type: "anthropic",
    name: "anthropic",
    displayName: "Anthropic",
    description: "Claude models via the Anthropic API",
    textIcon: "AN",
    iconSrc: anthropicIcon,
    color: "#D97757",
    credentialUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    type: "blackbox",
    name: "blackbox",
    displayName: "BlackBoxAI",
    description: "BlackBox AI coding models (OpenAI-compatible)",
    textIcon: "BB",
    iconSrc: blackboxIcon,
    color: "#6366F1",
    credentialUrl: "https://www.blackbox.ai/api-management",
  },
  {
    type: "deepseek",
    name: "deepseek",
    displayName: "DeepSeek",
    description: "DeepSeek chat & reasoner models",
    textIcon: "DS",
    iconSrc: deepseekIcon,
    color: "#0EA5E9",
    credentialUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    type: "xai",
    name: "xai",
    displayName: "xAI (Grok)",
    description: "Grok models from xAI",
    textIcon: "XA",
    color: "#E11D48",
    credentialUrl: "https://console.x.ai/",
  },
  {
    type: "glm",
    name: "glm",
    displayName: "GLM (Zhipu)",
    description: "Zhipu GLM models",
    textIcon: "GL",
    color: "#14B8A6",
    credentialUrl: "https://open.bigmodel.cn/",
  },
  {
    type: "codebuddy-global",
    name: "codebuddy-global",
    displayName: "CodeBuddy Global",
    description: "CodeBuddy International endpoint with Claude and mixed model support",
    textIcon: "CG",
    iconSrc: codebuddyIcon,
    color: "#2563EB",
    credentialUrl: "https://www.codebuddy.ai/",
    baseUrl: "https://www.codebuddy.ai/v2",
  },
  {
    type: "codebuddy-cn",
    name: "codebuddy-cn",
    displayName: "CodeBuddy China",
    description: "Tencent CodeBuddy China endpoint for regional accounts",
    textIcon: "CC",
    iconSrc: codebuddyIcon,
    color: "#DC2626",
    credentialUrl: "https://copilot.tencent.com/",
    baseUrl: "https://copilot.tencent.com/v2",
  },
  {
    type: "tokenrouter",
    name: "tokenrouter",
    displayName: "TokenRouter",
    description: "TokenRouter multi-provider gateway (OpenAI-compatible)",
    textIcon: "TR",
    color: "#0EA5E9",
    credentialUrl: "https://tokenrouter.com/",
    baseUrl: "https://api.tokenrouter.com/v1",
  },
  {
    type: "custom",
    name: "custom",
    displayName: "Custom",
    description: "Any OpenAI-compatible endpoint",
    textIcon: "CU",
    color: "#8B8B8B",
  },
];

export function presetForType(type: string): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.type === type) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]!;
}
