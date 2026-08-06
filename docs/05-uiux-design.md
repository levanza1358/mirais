# 05 — UI/UX Design (Dashboard)

## 1. Design Language

**Vibe:** a calm, premium "mission control" — dark-first, frosted-glass surfaces, one vivid accent. Think Linear × Vercel dashboard, tuned for a single-user gateway.

| Token | Dark (default) | Light |
|-------|----------------|-------|
| `bg-base` | `#0B0E14` | `#F6F7F9` |
| `bg-surface` | `#12161F` (glass: `rgba(18,22,31,.72)` + `backdrop-blur`) | `#FFFFFF` |
| `bg-raised` | `#1A2030` | `#F0F2F5` |
| `border` | `#232A3A` | `#E3E6EB` |
| `text-primary` | `#E8ECF4` | `#14181F` |
| `text-muted` | `#8B94A7` | `#5B6472` |
| `accent` | `#7C5CFF` (violet) — configurable in Settings | same |
| `success` | `#34D399` | `#0E9F6E` |
| `warning` | `#FBBF24` | `#B45309` |
| `danger` | `#F87171` | `#DC2626` |

- **Font:** Inter (UI) + JetBrains Mono (code/keys/logs). System fallback stack — no webfont download required at runtime (bundled by Vite).
- **Radius:** `12px` cards, `8px` inputs/buttons. **Shadows:** soft, low-spread.
- **Density:** comfortable (14px base font, 36px input height). Tables compact (32px rows).
- **Motion:** 150–200ms ease-out micro-transitions only (hover, modal fade, drawer slide). No gratuitous animation; respects `prefers-reduced-motion`.
- **Icons:** `lucide-react`, 16/18px, stroke 1.75.

## 2. App Shell

```
┌────────────────────────────────────────────────────────────────┐
│  ◆ Mirais        Search (⌘K)…            🔔  ⏻ status  avatar │
├──────────┬─────────────────────────────────────────────────────┤
│ Overview │  Page header: title + primary action button         │
│ Providers│                                                     │
│ Models   │                                                     │
│ Combos   │              PAGE CONTENT (max-w 1200px)            │
│ API Keys │                                                     │
│ Logs     │                                                     │
│ Settings │                                                     │
│          │                                                     │
│ ──────── │                                                     │
│ ● online │  footer: uptime · version · db size                 │
└──────────┴─────────────────────────────────────────────────────┘
```

- **Sidebar** 240px, collapsible to 64px icon rail; active item = accent left-bar + tinted bg.
- **Topbar:** global ⌘K command palette (jump to page, create key, test provider, toggle token saver), health dot (green/amber/red), theme toggle.
- **Mobile:** sidebar becomes bottom-sheet hamburger; pages stack single-column. (Dashboard is desktop-first but usable on a phone.)
- **Toasts** top-right; **modals** centered 480–640px; **drawers** slide from right for detail views (log detail, key detail).

## 3. Pages

### 3.1 Login (`/login`)
Centered card on a subtle aurora-gradient background: logo mark, "Mirais" wordmark, password field with show/hide eye, "Sign in" button, caps-lock hint, wrong-password shake + inline error, rate-limit countdown after 5 failures. No other chrome. Enter submits.

### 3.2 Overview (`/`)
**Purpose:** answer "is it working, what did it cost, where did traffic go?" in 5 seconds.

```
┌ Stat cards (4) ──────────────────────────────────────────────┐
│ Requests 24h   Tokens 24h      Est. cost 24h   Success rate   │
│ 1,284 ▲12%     8.4M ▲9%        $3.17 ▼41%*     99.1%           │
│                (*with token saver — vs list price)             │
└──────────────────────────────────────────────────────────────┘
┌ Requests & tokens (area chart, range switch 24h/7d/30d) ─────┐
└──────────────────────────────────────────────────────────────┘
┌ By model (bar, top 8) ────────┐ ┌ By provider (donut) ───────┐
└───────────────────────────────┘ └────────────────────────────┘
┌ Live activity (last 10 requests, auto-refresh 5s) ───────────┐
│ ✓ 12:01:04  claude-opus-4-7  anthropic  1.2k→3.4k  840ms     │
│ ✗ 12:01:31  combo:never-stop fallback→glm  429 cooldown      │
└──────────────────────────────────────────────────────────────┘
```
- Range switcher persists in localStorage. Empty state: friendly illustration + "Send your first request" with copyable curl.
- **Connect your app card:** copyable gateway Base URL (`http://localhost:1463/v1`) + the single default API key, always visible with a copy button (optional eye toggle to mask). If no key exists, one `default` key is auto-created. The server stores keys hashed only; the plaintext is kept in the browser's `localStorage` (local, password-protected dashboard) so it stays copyable across sessions. Keys created on the API keys page are remembered the same way and forgotten on delete.

### 3.3 Providers (`/providers`)
Card grid of **provider presets** (1-col → 4-col on xl), driven by a static catalog (`dashboard/src/providerCatalog.ts`): OpenAI (Codex), Anthropic, BlackBoxAI, Antigravity, Gemini, OpenRouter, DeepSeek, Groq, xAI, GLM, Custom. Each card:
```
┌──────────────────────────────────────┐
│ [OA] OpenAI (Codex)            ● ──○ │  ← status dot + enable switch
│      2 accounts · 14 models          │  ← or "Not configured" + Set up
└──────────────────────────────────────┘
```
- Colored text-icon tile per provider; status dot green when it has accounts.
- Cards always render for every preset — clicking an unconfigured card auto-creates the provider server-side, then navigates to its detail page.
- Per-card enable switch (click isolated from card navigation).

### 3.3.1 Provider detail (`/providers/:id`)
Header: back link, provider icon tile, name + type badge + disabled badge, "Get API key" external link, effective base URL (mono). Actions: **Test** (live latency toast), **Sync models**, enable switch, **Edit** (name/base URL/priority modal), **Delete** (confirm → back to grid).
- **Accounts card:** rows with status dot, label, masked key (`sk••••xxxx`), created time, enable switch, remove (confirm modal). **Add account** opens a modal with choices: *Login with ChatGPT* (OpenAI-type providers only — starts the Codex OAuth PKCE flow, opens the OpenAI login page in a new tab, waits with a spinner until the account appears; labeled `ChatGPT (email)`), *Single API key* (label + key with show/hide toggle), or *Bulk API keys* (textarea, one key per line — labels auto-generated, duplicates skipped, reports added/skipped counts). Accounts are fully addable/removable. The list is **paginated at 20 per page** with Prev/Next controls and a "1–20 of N · Page X / Y" indicator. Each row also shows **per-account usage** (`N req · M tok today`, hover for all-time totals + cost) aggregated from request logs — providers don't expose real quota/balance APIs, so this is the usage Mirais has routed through that key (auto-refreshes every 30s).
- **Models card:** active/disabled counts, **Fetch models** button (pulls the full model list from the provider's `/models` API; auto-fetches once when the provider has an enabled account but zero models), add-model input, model chips with enable toggle (line-through when disabled) and remove. Each chip shows **context length** (`128k ctx`), **max output** (`16k out`), and **capability badges** (Reasoning / Vision / PDF / Tools / JSON) captured during sync, with a full tooltip on hover. Each chip has a **test button** (⚡) that sends a tiny chat completion to the upstream and shows the result inline (✓ latency / ✗ error, hover for detail). **Test all** opens a choice modal: *Test all models only* or *Test all & delete error models* (failing models are removed after the run).

### 3.4 Models (`/models`)
- **Left:** filter rail — provider checkboxes, search, "enabled only".
- **Main:** table — Model, Provider, Display name, context/capability metadata, Enabled switch, Actions (edit metadata, test in playground).
- **Aliases section** on top: chips `fast → openrouter/auto` with add/remove.
- **Playground drawer** (per model): chat box, streaming output, token meter, "send as OpenAI / as Anthropic" toggle to demo translation. History kept in memory only.

### 3.5 Combos (`/combos`)
- List of combos as cards; each card = vertical chain with numbered steps and connector line.
- **Editor modal:** name + drag-and-drop sortable list of targets (autocomplete from all enabled models/aliases), remove buttons, "add step".
- Strategy selector: `sequential` (v1 only; UI hints "parallel/judge — coming soon" disabled).
- "Test resolution" button → shows ordered provider attempts with live health.
- Empty state with sample `never-stop` template one-click create.

### 3.6 API Keys (`/keys`)
Table: Label, Key (prefix + copy-disabled note), Created, Last used, Limits (rpm/concurrency/budget chips), Usage today (bar), Enabled, Actions.
- **Create modal:** label; optional allowed-models multi-select; optional limits (numeric inputs with "∞" placeholder); expiry date picker. On success → **one-time reveal screen**: full key in mono, copy button, "you won't see this again" warning, curl snippet ready to paste into Claude Code/Cursor settings.
- Disable → row greys out; revoke → confirm modal ("existing clients will break").

### 3.7 Logs (`/logs`)
- Sticky filter bar: status (all/success/error), model, provider, key, free-text search, time range, auto-refresh toggle.
- Virtualized table (thousands of rows): time, status icon, endpoint, requested model → routed model, provider, tokens (in→out, saved badge `-312 tok`), latency.
- **Row → right drawer:** full timeline of attempts (`attempt 1 anthropic 429 → cooldown`, `attempt 2 openai ✓`), headers, and (when `TRACK_PAYLOADS=full`) collapsible pretty-printed request/response JSON with copy buttons.
- Footer: "purge logs older than …" action.

### 3.8 Settings (`/settings`)
Tabbed page (`General · Token Saver · Security · Data · About`):

1. **General** — port/host display (from env, read-only), theme (dark/light/system), accent color picker, session TTL.
2. **Token Saver** — master switch; per-rule toggles (git diff, grep, ls/tree, long-output) with live demo panel: paste tool output → shows compressed result + token delta.
3. **Security** — "Never ask password by default" toggle (pre-checks the login checkbox; remember-me sessions last 30 days, standard sessions `SESSION_TTL_HOURS`); change dashboard password; view active sessions (revoke); note about `DATA_DIR` permissions.
4. **Data** — DB size, retention days slider, "backup now", export/import config JSON, danger zone: wipe logs / factory reset (type-to-confirm).
5. **About** — version, uptime, links to docs, license.

## 4. UX Principles & States

- **Optimistic UI** on toggles; rollback + toast on failure.
- **Every list** has: loading skeleton (shimmer rows), empty state (illustration + one clear CTA), and error state (retry button).
- **Destructive actions** always confirm-modaled with typed name when wiping data.
- **Copy-to-clipboard** everywhere a key/endpoint appears; check-mark feedback.
- **Keyboard:** ⌘K palette, `g o/p/m/c/k/l/s` go-to shortcuts, `Esc` closes modals/drawers.
- **Accessibility:** full focus rings, aria-labels on icon buttons, contrast AA on both themes.
- **Realtime:** Overview & Logs poll every 5s (SSE upgrade path in v2); health dot polls `/health` every 10s.

## 5. Component Inventory (build once, reuse)

`Button (primary/ghost/danger)`, `IconButton`, `Input`, `PasswordInput`, `Select`, `MultiSelect`, `Switch`, `Badge/StatusDot`, `Card`, `StatCard`, `Table + VirtualTable`, `Tabs`, `Modal`, `ConfirmModal`, `Drawer`, `Toast`, `Tooltip`, `EmptyState`, `Skeleton`, `CodeBlock (mono + copy)`, `SearchInput`, `RangeSwitcher`, `Chart wrappers (AreaChart, BarChart, Donut)`, `SortableList` (combos), `TokenMeter`.
