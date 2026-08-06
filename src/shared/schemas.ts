import { z } from "zod";

// ── OpenAI Chat Completions ──

const contentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  image_url: z.object({ url: z.string(), detail: z.string().optional() }).optional(),
  tool_use_id: z.string().optional(),
  content: z.string().optional(),
}).passthrough();

export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool", "developer"]),
  content: z.union([z.string(), z.array(contentPartSchema)]).nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(z.object({
    id: z.string(),
    type: z.literal("function"),
    function: z.object({ name: z.string(), arguments: z.string() }),
  })).optional(),
  tool_call_id: z.string().optional(),
}).passthrough();

export const chatCompletionsSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(z.object({
    type: z.literal("function"),
    function: z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.unknown()).optional(),
    }),
  })).optional(),
  tool_choice: z.unknown().optional(),
  response_format: z.unknown().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
}).passthrough();

// ── Anthropic Messages ──

export const anthropicMessagesSchema = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive().optional(),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.union([z.string(), z.array(z.record(z.unknown()))]),
  })).min(1),
  system: z.union([z.string(), z.array(z.record(z.unknown()))]).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.unknown()).optional(),
  }).passthrough()).optional(),
  tool_choice: z.unknown().optional(),
}).passthrough();

// ── Admin payloads ──

export const providerCreateSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/, "lowercase letters, digits, dash, underscore"),
  type: z.enum(["openai", "anthropic", "deepseek", "xai", "glm", "blackbox", "codebuddy-global", "codebuddy-cn", "custom"]),
  baseUrl: z.string().url().optional().nullable(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
});

export const providerUpdateSchema = providerCreateSchema.partial();

export const accountCreateSchema = z.object({
  label: z.string().min(1).max(64),
  apiKey: z.string().min(1),
  priority: z.number().int().optional(),
});

export const accountBulkCreateSchema = z.object({
  apiKeys: z.array(z.string().min(1)).min(1).max(2000),
  labelPrefix: z.string().min(1).max(48).optional(),
});

export const accountUpdateSchema = z.object({
  label: z.string().min(1).max(64).optional(),
  apiKey: z.string().min(1).optional(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

export const aliasCreateSchema = z.object({
  alias: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/),
  target: z.string().min(1),
});

export const comboCreateSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/),
  strategy: z.enum(["sequential"]).default("sequential"),
  chain: z.array(z.string().min(1)).min(1).max(10),
});

export const comboUpdateSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/).optional(),
  chain: z.array(z.string().min(1)).min(1).max(10).optional(),
});

export const keyCreateSchema = z.object({
  label: z.string().min(1).max(64),
  allowedModels: z.array(z.string()).optional().nullable(),
  rateLimitRpm: z.number().int().positive().optional().nullable(),
  concurrency: z.number().int().positive().optional().nullable(),
  dailyTokenBudget: z.number().int().positive().optional().nullable(),
  expiresAt: z.string().datetime().optional().nullable(),
});

export const keyUpdateSchema = z.object({
  label: z.string().min(1).max(64).optional(),
  allowedModels: z.array(z.string()).optional().nullable(),
  rateLimitRpm: z.number().int().positive().optional().nullable(),
  concurrency: z.number().int().positive().optional().nullable(),
  dailyTokenBudget: z.number().int().positive().optional().nullable(),
  expiresAt: z.string().datetime().optional().nullable(),
  enabled: z.boolean().optional(),
});

export const settingsUpdateSchema = z.object({
  token_saver: z.object({
    enabled: z.boolean(),
    rules: z.object({
      gitDiff: z.boolean(),
      grep: z.boolean(),
      ls: z.boolean(),
      longOutputMaxLines: z.number().int().min(10).max(2000),
    }),
  }).optional(),
  terse_mode: z.object({
    enabled: z.boolean(),
    prompt: z.string().max(500),
  }).optional(),
  log_retention_days: z.number().int().min(1).max(365).optional(),
  session_remember_default: z.boolean().optional(),
  model_sync_mode: z.enum(["curated", "all"]).optional(),
  routing_policy: z.object({
    mode: z.enum(["balanced", "priority", "sticky"]).optional(),
    preferProviders: z.array(z.string().min(1)).max(20).optional(),
    denyProviders: z.array(z.string().min(1)).max(50).optional(),
    denyModels: z.array(z.string().min(1)).max(200).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    respectPriority: z.boolean().optional(),
  }).optional(),
  ui: z.object({
    theme: z.enum(["dark", "light"]),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }).optional(),
});

export const passwordChangeSchema = z.object({
  current: z.string(),
  next: z.string().min(6).max(128),
});
