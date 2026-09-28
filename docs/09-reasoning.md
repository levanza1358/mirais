# Universal reasoning with Mirais

Mirais translates one universal `reasoning` block into the dialect each upstream actually wants, so an agent harness can keep a single config across OpenAI, Anthropic, xAI, ChatGPT Codex, GitHub Copilot, CodeBuddy, BlackBox, Atria, DeepSeek, Zhipu GLM, and any custom OpenAI-compatible endpoint.

This guide covers:

1. The universal schema
2. Provider × reasoning matrix
3. How to enable reasoning from common agent harnesses
4. Tuning defaults, per-provider overrides, and budgets
5. Troubleshooting

## 1. The universal `reasoning` block

Send a top-level `reasoning` object with any chat-completion, Responses, or Anthropic Messages request. All fields are optional and only the relevant ones are forwarded to each upstream.

```json
{
  "model": "claude-opus-4-7",
  "messages": [{ "role": "user", "content": "Summarise the diff" }],
  "reasoning": {
    "enabled": true,
    "effort": "high",
    "budget_tokens": 8192,
    "summary": "concise",
    "include": ["reasoning.encrypted_content"]
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `enabled` | `boolean` | Explicit opt-out. `false` removes every reasoning field the upstream would otherwise receive. |
| `effort` | `"minimal" \| "low" \| "medium" \| "high" \| "xhigh"` | Universal effort hint. Mirais maps it to the dialect-specific enum and clamps it to the levels the model accepts. |
| `budget_tokens` | `number` (1 … 2 000 000) | Anthropic extended-thinking budget. Clamped against the model's `max_output_tokens` and the global `reasoning.max_budget_tokens` setting. Other dialects ignore the field. |
| `summary` | `"concise" \| "detailed"` | Forwarded to OpenAI Responses / Codex / xAI Responses. |
| `include` | `string[]` | Allowlist of extra reasoning outputs (e.g. `reasoning.encrypted_content` for xAI multi-turn continuity). |
| `thinking` | `{ type: "enabled" \| "adaptive", budget_tokens?: number }` | Anthropic-native passthrough. Inbound Anthropic requests with a `thinking` block are mapped into canonical `reasoning` and re-translated on the way out. |

> Privacy: reasoning content is **never** stored in `request_logs.response_body`. The `reasoning_effort` column captures the requested mode; `reasoning_tokens` captures the upstream-reported reasoning token bucket. Raw traces stay with the model.

## 2. Provider × reasoning matrix

| Provider | Dialect | effort | budget | summary | include | streams `reasoning_content` | reports `reasoning_tokens` |
|---|---|---|---|---|---|---|---|
| OpenAI | openai-responses | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| Anthropic | anthropic | — | ✓ | — | — | ✓ | — |
| xAI Grok | xai-chat / xai-responses | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| ChatGPT Codex | codex | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| GitHub Copilot | copilot | — | — | — | — | — | — |
| CodeBuddy (global / CN) | codebuddy | — | — | — | — | — | — |
| DeepSeek | openai-chat | ✓ | — | — | — | ✓ | — |
| BlackBox | openai-chat | ✓ | — | — | — | — | — |
| Atria | openai-chat | ✓ | — | — | — | — | — |
| Zhipu GLM | openai-chat (Z.ai Coding Plan → anthropic) | ✓ | — | — | — | ✓ | — |
| Custom OpenAI-compatible | custom | ✓ | — | — | — | depends on upstream | depends on upstream |

Mirais **strips** every reasoning field an upstream rejects. CodeBuddy, for example, returns `11128` if it sees `reasoning` or `reasoning_effort`; Mirais never forwards them.

### Dialek-specific quirks

- **OpenAI Chat Completions** (`reasoning_effort`): `minimal` is accepted. The block is dropped if `enabled === false`.
- **OpenAI Responses** (`reasoning: { effort, summary, include }`): `summary` defaults to `concise`. `include` is passed through.
- **Anthropic**: `thinking.type` defaults to `enabled`. Set `thinking.type = "adaptive"` for Claude 4.7+ when you want the model to decide the budget. `temperature` and `top_p` are dropped when thinking is on (Anthropic requirement).
- **xAI Grok CLI (`grok-4.5`)**: maps `effort` to `low|medium|high|xhigh`. `minimal` collapses to `low`. `max` → `xhigh`. If the client does not specify an effort, Mirais falls back to Grok-4.5's maximum effective effort for tool requests. Always emits `include: ["reasoning.encrypted_content"]` for multi-turn continuity.
- **ChatGPT Codex**: `effort` and `summary` are forwarded; `budget_tokens` is server-managed. The Codex backend rejects `max_output_tokens`, `temperature`, and `top_p`; Mirais does too.
- **GitHub Copilot**: Mirais passes the request through. Reasoning behaviour is owned by the Copilot SDK and the upstream model catalog.
- **CodeBuddy**: `reasoning`, `reasoning_effort`, `stream_options`, `service_tier` are stripped. See `docs/08-codebuddy-compatibility.md`.

## 3. Enabling reasoning from common harnesses

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:1463
export ANTHROPIC_AUTH_TOKEN=<mirais-gateway-key>
claude --model claude-opus-4-7 --thinking high
```

Claude Code sends Anthropic Messages; Mirais maps `thinking` blocks to canonical and re-emits them. No config changes needed for budgets — set them per request via Anthropic's `thinking` field, or set a global default in **Settings → Reasoning**.

### Cursor / Cline / Codex / Continue (OpenAI dialect)

These tools speak Chat Completions or Responses natively. Point them at `http://localhost:1463/v1`:

```json
{
  "model": "combo:default",
  "messages": [{ "role": "user", "content": "Refactor src/auth.ts" }],
  "reasoning": { "effort": "high" }
}
```

The block is translated to `reasoning_effort` for Chat Completions or `reasoning.effort` for Responses. `enabled: false` is honoured.

### OpenAI Agents SDK

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:1463/v1", api_key="<mirais-gateway-key>")
client.responses.create(
    model="combo:default",
    input="Find the bug in src/auth.ts",
    reasoning={"effort": "high", "summary": "concise"},
)
```

The Responses endpoint accepts `reasoning.effort`, `reasoning.summary`, and `reasoning.include`.

### Claude Code / Cursor via Anthropic SDK with custom reasoning

```python
import anthropic
client = anthropic.Anthropic(base_url="http://localhost:1463", auth_token="<key>")
client.messages.create(
    model="claude-opus-4-7",
    max_tokens=4096,
    thinking={"type": "enabled", "budget_tokens": 8192},
    messages=[{"role": "user", "content": "Plan a migration"}],
)
```

Mirais captures the `thinking` block into canonical `reasoning` so the same route is used regardless of whether the client spoke OpenAI or Anthropic.

### Raw curl

```bash
curl http://localhost:1463/v1/chat/completions \
  -H "Authorization: Bearer <mirais-gateway-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "combo:default",
    "messages": [{"role":"user","content":"Hello"}],
    "stream": true,
    "reasoning": {"effort": "high"}
  }'
```

## 4. Defaults, overrides, and budgets

Open **Settings → Reasoning** in the dashboard. Three cards:

1. **Defaults** — applied to any request that omits the `reasoning` block. An explicit `enabled: false` on the client always wins.
2. **Provider overrides** — pin Anthropic to a higher budget, disable reasoning on a single provider that misbehaves, or override the default effort for one provider without touching the global default.
3. **Provider × reasoning capability** — read-only matrix summarising which fields each upstream accepts.

Set the global `max_budget_tokens` to enforce an operator-side cap on Anthropic extended thinking. The executor clamps the request budget to `min(global_max, model.max_output_tokens)` before forwarding.

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `effort: "minimal"` is ignored by xAI | xAI's lowest level is `low`. | Mirais collapses `minimal` to `low` automatically. No action needed. |
| Anthropic returns 400 with `temperature` set | Anthropic rejects `temperature` when thinking is on. | Mirais drops `temperature`/`top_p` when `reasoning` is present. If your client re-adds them, send the universal `reasoning` block. |
| `reasoning.budget_tokens: 1000000` is rejected | Anthropic 4.7 cap is 64 000; Mirais clamps against the global `max_budget_tokens` setting too. | Either lower the budget, or raise the global cap in **Settings → Reasoning**. |
| Codex returns 400 on `max_output_tokens` | Codex backend rejects that field. | Mirais strips it. Do not set it manually for Codex accounts. |
| `reasoning_content` is missing in client logs | `request_logs.response_body` is redacted to keep model traces off disk. | Use the live `/v1/*` stream; reasoning content is not persisted. |
| Provider ignored the `reasoning` block | Some providers (CodeBuddy, GitHub Copilot) don't take it. | Mirais strips the field; refer to the matrix for which dialects accept which field. |
| Stats show `Reasoning tokens: —` | Provider did not report `output_tokens_details.reasoning_tokens`. | OpenAI Responses, Codex, and xAI do; Anthropic does not. |

For deeper coverage of how the executor picks providers, see `docs/01-architecture.md`. For the API spec, `docs/03-api-specification.md`.