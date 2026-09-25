# CodeBuddy compatibility

Status: Implemented

## Behavior

Mirais CodeBuddy routes send only the OpenAI Chat Completions fields accepted by the
CodeBuddy endpoint. Canonical gateway-only fields such as `reasoning`, `stream_options`,
and `service_tier` are removed at this provider boundary. Supported reasoning effort is
translated to `reasoning_effort` only for providers that accept that field; CodeBuddy
requests omit it unless explicitly supported by its route.

CodeBuddy requests keep the CLI-compatible request headers, including
`X-Requested-With`, `X-Product`, `X-IDE-Type`, `X-IDE-Name`, and `x-codebuddy-request`.

## Acceptance

1. CodeBuddy receives standard `messages`, `tools`, `tool_choice`, `max_tokens`, and
   `stream` fields only.
2. Mesa Code requests containing canonical reasoning metadata do not forward the
   unsupported `reasoning` object to CodeBuddy.
3. CodeBuddy security failures such as `11128` are returned unchanged; Mirais does not
   retry them or disguise them as model failures.
