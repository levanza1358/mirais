import { z } from "zod";

/** Browser URL returned by OpenAI's fixed Codex localhost OAuth callback. */
export const oauthCallbackUrlSchema = z.object({
  url: z.string().min(1).max(16_384),
});

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
      strict: z.boolean().optional(),
    }),
  })).optional(),
  tool_choice: z.unknown().optional(),
  response_format: z.unknown().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  reasoning: z.object({
    enabled: z.boolean().optional(),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
    budget_tokens: z.number().int().min(0).max(2_000_000).optional(),
  }).optional(),
}).passthrough();

const responsesContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["input_text", "output_text"]), text: z.string() }),
  z.object({ type: z.literal("input_image"), image_url: z.string().url() }),
]);

const responsesInputItemSchema = z.union([
  z.object({
    type: z.literal("message").optional(),
    role: z.enum(["user", "assistant", "system", "developer"]),
    content: z.union([z.string(), z.array(responsesContentPartSchema).min(1)]),
  }),
  z.object({ type: z.literal("function_call"), call_id: z.string().min(1), name: z.string().min(1), arguments: z.string() }),
  z.object({ type: z.literal("function_call_output"), call_id: z.string().min(1), output: z.string() }),
]);

export const responsesCreateSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(responsesInputItemSchema).min(1)]),
  instructions: z.string().optional(),
  stream: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  tools: z.array(z.object({
    type: z.literal("function"),
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
    strict: z.boolean().optional(),
  })).optional(),
  tool_choice: z.unknown().optional(),
  reasoning: z.object({ effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional() }).optional(),
  store: z.literal(false).nullable().optional(),
  background: z.literal(false).nullable().optional(),
  previous_response_id: z.null().optional(),
  parallel_tool_calls: z.boolean().optional(),
  text: z.object({ format: z.union([
    z.object({ type: z.literal("text") }),
    z.object({ type: z.literal("json_object") }),
    z.object({ type: z.literal("json_schema"), name: z.string().min(1), schema: z.record(z.unknown()), strict: z.boolean().optional() }),
  ]).optional() }).optional(),
  metadata: z.record(z.string()).optional(),
  user: z.string().optional(),
  safety_identifier: z.string().optional(),
  service_tier: z.string().optional(),
  truncation: z.literal("disabled").optional(),
}).strict().superRefine((value, ctx) => {
  void value;
});

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
  sessionCookie: z.string().max(8192).nullable().optional(),
});

export const aliasCreateSchema = z.object({
  alias: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/),
  target: z.string().trim().min(1).max(1024),
});

export const providerModelUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(256).nullable().optional(),
  enabled: z.boolean().optional(),
  contextLength: z.number().int().positive().max(10_000_000).nullable().optional(),
  maxOutputTokens: z.number().int().positive().max(10_000_000).nullable().optional(),
  capabilities: z.array(z.string().trim().min(1).max(64)).max(32).nullable().optional(),
}).strict();

export const upstreamModelSchema = z.object({
  id: z.string().trim().min(1).max(1024),
  context_length: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  top_provider: z.object({
    context_length: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
  }).passthrough().optional(),
  supported_parameters: z.array(z.string()).optional(),
  capabilities: z.record(z.boolean()).optional(),
}).passthrough();

export const upstreamModelsResponseSchema = z.object({
  data: z.array(upstreamModelSchema),
}).passthrough();

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
      maxToolOutputChars: z.number().int().min(1000).max(1_000_000).optional(),
      collapseWhitespace: z.boolean().optional(),
      deduplicateToolOutputs: z.boolean().optional(),
      keepRecentToolResults: z.number().int().min(0).max(100).optional(),
      gitStatus: z.boolean().optional(),
      findTree: z.boolean().optional(),
      buildLogs: z.boolean().optional(),
    }),
  }).optional(),
  terse_mode: z.object({
    enabled: z.boolean(),
    prompt: z.string().max(500),
  }).optional(),
  log_retention_days: z.number().int().min(1).max(365).optional(),
  session_remember_default: z.boolean().optional(),
  network_binding: z.object({
    exposed: z.boolean(),
    host: z.enum(["0.0.0.0", "127.0.0.1"]),
  }).optional(),
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
  xai_imap: z.object({
    enabled: z.boolean(),
    gmail_username: z.string().email(),
    gmail_app_password: z.preprocess(
      (value) => typeof value === "string" ? value.replace(/[\s-]/g, "") : value,
      z.string().length(16, "Gmail App Password must contain exactly 16 characters"),
    ),
    email_domain: z.string().min(1),
    account_password: z.string().min(8).max(128).optional(),
    headless: z.boolean(),
    otp_check_interval: z.number().int().min(1).max(60),
    otp_max_retries: z.number().int().min(1).max(60),
  }).optional(),
});

export const passwordChangeSchema = z.object({
  current: z.string(),
  next: z.string().min(6).max(128),
});
