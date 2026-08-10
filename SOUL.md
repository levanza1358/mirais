# SOUL.md — The Spirit of Mirais

## Name

**Mirais** (未来 / *mirai* = "future") — the gateway you run today that keeps your AI workflow alive no matter what changes upstream.

## Mission

> **Never stop coding.** One local endpoint that turns a pile of provider accounts, free tiers, and API keys into a single, reliable, observable AI connection — owned by you, running on your machine.

## What Mirais believes

1. **Local-first, always.**
   Your keys, your logs, your data — on your disk, in one folder (`DATA_DIR`). Nothing phones home. There is no account system, no telemetry, no "anonymous usage stats". If the internet cut everything except LLM upstreams, Mirais would still work perfectly.

2. **Reliability beats features.**
   A gateway exists so that a 429 or a dead provider is a non-event. Failover, cooldowns, and multi-account rotation are not features — they are the point. A feature that compromises a request in flight gets cut.

3. **Honesty in the UI.**
   The dashboard shows real numbers: real tokens, real latency, real errors, estimated cost clearly labeled *estimated*. No vanity metrics, no dark patterns, no upsell banners.

4. **Small is beautiful.**
   One process, one port (`1463`), one SQLite file, one config file. If something can be done with a Bun built-in instead of a dependency, it is. Every dependency must justify its weight. The whole system should fit in one person's head.

5. **Open protocols, not lock-in.**
   Mirais speaks the APIs people already use (OpenAI, Anthropic) so any tool works with zero Mirais-specific SDK. If you delete Mirais tomorrow, your tools just point somewhere else. Nothing is trapped.

6. **Craft.**
   The dashboard should feel like a tool you enjoy opening: fast, calm, dark, precise. Compression, failover, and translation should be invisible when they work and explain themselves when they don't (attempt timelines, saved-token badges).

## What Mirais will never do

- Charge money, show ads, or require an account
- Send your prompts, keys, or usage anywhere
- Require a cloud service to function
- Break on Windows *or* Linux — both are first-class citizens
- Grow into a platform; it stays a sharp, single-purpose gateway

## Personality (for UI copy & docs)

Calm, direct, competent. Short sentences. No exclamation marks, no hype words ("blazing", "revolutionary"), no emoji in the product UI (status icons only). Error messages say what happened and what to do next.

## Lineage

Standing on good ideas, credit where due:
- **[9Router](https://github.com/decolua/9router)** — token-saving philosophy, tiered fallback thinking
- **[Cartethyia](https://github.com/risunCode/Cartethyia)** — protocol-translation purity, clean modular architecture

Mirais is not a fork. It is a fresh, minimal take on the same promise.
