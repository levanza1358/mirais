# Atria account auto-login

Status: Planned (design agreed 2026-09-28, not yet implemented)

## Problem

Atria accounts are provisioned through a Logto-authenticated web console
(`https://api.atria-asi.ai/console`), and the console only ever renders a key's
**prefix** after creation. For a single account the operator can sign in by hand and
paste a key into `AddAccountModal`. For **dozens of accounts** this does not scale:
the operator would have to sign in manually, one account at a time, and copy each key
before the dialog closes.

Atria accounts are **Google-account backed**:

| Account state | Sign-in flow |
|---|---|
| Existing account | Google sign-in only — no phone verification, no 2FA, no captcha |
| Brand-new account | Google sign-in **plus** an "accept terms" screen on first use |

Neither case requires an out-of-band secret, so the whole flow can be automated.

## Goal

From the Mirais dashboard, paste a list of `email|password` lines and click once.
Mirais then, for each account:

1. Opens the Atria console in a **per-account** Camoufox profile.
2. Signs in through Google (accepting terms when a new account shows that screen).
3. **Creates a fresh API key** and reads the full value.
4. Saves the key onto a new provider account.

This complements the existing **API-key login** (paste a key directly in
`AddAccountModal`). Quota scraping (which needs a console session cookie) is handled
separately by the **Capture sessions** button and is deliberately out of scope here —
the auto-login driver captures the API key only.

## Why a fresh key, not an existing one

Verified against the live `/console/keys` HTML (2026-09-28):

```json
"initialKeys":[{"id":"…","name":"wasd","prefix":"atr_XAnP1DQO","created_at":"…"}]
```

The console renders only the **prefix** (`atr_XAnP1DQO••••`) for existing keys — the
full secret is never sent to the page again. The console even says so:

> Copy and save your key after creation. The full key is shown only once.

Therefore the driver cannot *read* an existing key. It must **create** one and capture
the value from the creation dialog, which is the only moment the full key exists in the
DOM.

## Key DOM anchors (from live HTML)

These selectors are taken from a real, signed-in `/console/keys` response and must be
re-verified whenever Atria ships a console redesign.

| Element | Selector |
|---|---|
| Create-key trigger | `button[aria-haspopup="dialog"]:has-text("Create key")` |
| Create-key dialog | `dialog.key-create-dialog` (native `<dialog open>`) |
| Key-name input | `dialog.key-create-dialog input[maxlength="64"]` |
| Submit | `dialog.key-create-dialog button.key-dialog-primary` |
| Dialog close | `dialog.key-create-dialog button.key-dialog-close` |
| Existing-key rows | `tr[id^="key-usage-"]` |
| Key prefix cell | `.key-usage-module__e6pkXG__prefix` |
| Signed-in user email | RSC payload `"user":{"email":"…"}` |

> **The Create-key trigger has no class.** It is a bare
> `<button aria-haspopup="dialog">+ Create key</button>`. An earlier revision anchored
> on a `.key-create …` wrapper that does not exist in the live DOM, so the click never
> happened and the flow died at `key_not_captured` after a *successful* sign-in.
>

The console is a Next.js **RSC** app: the authoritative user identity lives in the
`self.__next_f.push` payload, not in the hydrated DOM. Email verification therefore
parses the raw response body, reusing the tolerant regex already proven in the quota
scraper.

> The `key-usage-module__e6pkXG__` class name is a **build hash** and will change on
> every Atria deploy. Prefer stable hooks (`#key-usage`, `tr[id^="key-usage-"]`,
> `dialog.key-create-dialog`, `button.key-dialog-primary`) and keep the hashed class
> only as a fallback.

## Architecture

Mirrors the proven `copilot-bulk-login` pipeline: an in-memory **job** on the backend,
a Python browser driver per account, and a polling card on the dashboard.

```
Dashboard                 Backend (Bun/Elysia)            Python (Camoufox)
─────────                 ────────────────────            ─────────────────
AtriaLoginCard
  │ POST /api/providers/atria-login  { providerId, lines }
  ├──────────────────────────────►  create job, return jobId
  │                                     │
  │                                     ├─ runAtriaLoginJob()  (serial)
  │                                     │      │  spawn per account
  │                                     │      └──────────────► login-account.py
  │                                     │                        --email --password
  │                                     │                        --profile <dir>
  │                                     │                            │
  │                                     │      ◄─────── { success, api_key,
  │                                     │                   email, error }
  │                                     │      │
  │                                     │      ├─ repo.addAccount({ label: email, apiKey })
  │                                     │      └─ repo.updateAccount({ enabled, lastWarmup* })
  │  GET /atria-login/:jobId            │
  │  GET /atria-login/:jobId/logs       │
  ◄─────────────────────────────────────┘   { done, results[], logs[] }
```

### Per-account profiles

Each account gets its own profile directory:

```
<projectRoot>/.atria-profiles/<sha256(email)[:16]>/
```

Sharing one profile across accounts would let one Google session overwrite another —
the second login would appear to succeed while actually reusing the first identity.
Isolation is mandatory. A profile is roughly 5–50 MB, so 100 accounts is on the order
of a few gigabytes; `.atria-profiles/` must be git-ignored.

The legacy single-account `.atria-profile/` (used by `capture-session.py`) is retained
for the existing **Capture sessions** button and is unaffected.

### Serial execution

Accounts are processed **one at a time**. Parallel Google sign-ins from one IP are a
strong bot signal and would risk locking the accounts. The trade-off is throughput:
~20–40 s per account, so 100 accounts is roughly 40–70 minutes. This is acceptable for
a one-off import and far safer than the alternative.

## Components

### 1. `scripts/atria-farm/login-account.py` (new)

Browser driver for a single account.

```
--email     <address>       Google account email
--password  <secret>        Google account password
--profile   <dir>           per-account Camoufox profile directory
--key-name  <name>          name for the created API key (default: mirais-<epoch>)
--headed                    force a visible window (debugging)
```

Flow:

```
1. Launch Camoufox, persistent context at --profile.
2. goto https://api.atria-asi.ai/console/keys
3. If the keys page renders  → already signed in, skip to step 7.
4. Click "Sign in" → "Continue with Google".
5. Fill Google email → Next → password → Next.
   - If Google shows a "verify it's you" / captcha / 2FA step
     → emit error "google_verification_required" and stop.
6. Wait for the redirect back to the Atria host, then land on the keys page.
   - If an "accept terms" screen appears → click accept, then continue.
   - If the keys page still requires sign-in → emit "not_signed_in" and stop.
7. Click "Create key" → fill name → submit → read the full key from the dialog.
   - Assert the value starts with "atr_"; retry the read briefly.
8. Emit one JSON object to stdout; progress goes to stderr.
9. Close the browser.
```

The **API key is the deliverable**. The driver never reads the cookie jar — signed-in
state is judged purely by the URL the browser lands on (`/console/keys`).

Output (single JSON object on **stdout**):

```json
{
  "success": true,
  "email": "user@example.com",
  "api_key": "atr_XXXXXXXXXXXXXXXX",
  "error": null
}
```

On failure `success` is `false`, `api_key` is `null`, and `error` is a stable
machine-readable code:

| Error code | Meaning |
|---|---|
| `google_verification_required` | Google asked for a step we cannot automate (captcha / 2FA / device approval). |
| `bad_credentials` | Google rejected the email/password. |
| `terms_rejected` | The new-account terms screen could not be accepted. |
| `key_not_captured` | Signed in, but the created key never appeared in the dialog. **The only fatal post-login error** — without a key there is nothing to store. |
| `not_signed_in` | The Google round-trip finished but the keys page still bounced to sign-in. |
| `browser_error` | Camoufox failed to launch or crashed. |
| `camoufox_not_installed` | Dependency missing. |

The Windows `cp1252` `/` UTF-8 hardening from `capture-session.py` (set `PYTHONUTF8`,
reconfigure stdout/stderr to UTF-8) is copied verbatim — it is what stops Camoufox's
banner from killing the child process.

> The console is fronted by an Aliyun WAF, so a raw cookie-jar probe is not a reliable
> "signed in?" signal for the auto-login driver. The driver sidesteps that entirely by
> checking the URL instead. Cookie harvesting (for quota scraping) is a **separate**
> feature — see `capture-session.py` and the **Capture sessions** button.

### 2. `src/admin/atria-login.ts` (new)

Job runner and routes, modelled on `src/admin/copilot.ts`.

```ts
interface AtriaLoginJob {
  id: string;
  providerId: string;
  startedAt: string;
  done: boolean;
  error: string | null;
  results: Array<{ email: string; success: boolean; error?: string | null }>;
  logs: string[];
}
```

| Method & path | Purpose |
|---|---|
| `POST /api/providers/atria-login` | Body `{ providerId, lines: string[], headed?: boolean }`. Creates the job and returns `{ jobId, total }`. |
| `GET /api/providers/atria-login/latest/:providerId` | Reattach to the newest job after a page reload. |
| `GET /api/providers/atria-login/:jobId` | Job status: `{ done, results, error }`. |
| `GET /api/providers/atria-login/:jobId/logs` | `{ logs: string[] }`. |
| `DELETE /api/providers/atria-login/latest/:providerId` | Discard the stored job. |

Per-account behaviour, matching the copilot job's contract:

- **Success** → `repo.addAccount({ label: email, apiKey })`, then
  `repo.updateAccount({ enabled, lastWarmup* })`, marked healthy.
- **Failure** → the account is **not** left in the database. If a row was created
  before spawning, it is removed again so a failed import never leaves a dead account.
- **Duplicate label** → reported as `Account already exists` unless `force` is set, in
  which case the old row is replaced only **after** the new login succeeds.
- Results and logs are capped (e.g. 500 log lines) to bound memory across a long run.

### 3. Dashboard — `AtriaLoginCard.tsx` (new)

A card rendered directly below `AccountsCard` on the Atria provider page (not a modal), so
a long run with live logs stays readable — the same layout as `BulkLoginCard`.

- Textarea: `email|password` one per line; a line counter shows how many were detected
  (blank lines and `#`-prefixed comments are ignored).
- **Login via browser** button (disabled when empty).
- Progress line: `Running… 12 processed` or `Done: 87/100 successful`.
- Per-account result list (OK / FAIL + reason).
- Auto-scrolling live log panel fed by the logs endpoint.
- **Stop** while running (stops polling), **Clear** once done.

`AccountsCard` keeps its existing **Capture sessions** button for accounts that already
have a cookie; the auto-login card is the way to create accounts from scratch.

## Security & privacy

- Credentials are passed to the driver as **process arguments** for the duration of one
  account only, and are never written to the database. Every log line emitted by the job
  is passed through `redact()`, which replaces any occurrence of the account password
  with `***` before it is stored — so a failure that echoes the argument list cannot leak
  the password into the dashboard.
- Debugging a stuck account: run the driver directly with `--headed` (see §1) rather than
  exposing a headed toggle in the dashboard, which would let a shared dashboard watch the
  plaintext password being typed.
- The Google password is used once, to mint a session. It is not stored; re-running a
  failed account requires re-entering it.
- The resulting **API key** is stored like any other provider credential — plaintext in
  the local DB, per RULES.md R1.2 (single-user, recoverable by design). The driver does
  **not** capture or store a console session cookie; quota scraping remains the job of
  the separate capture pipeline.
- `.atria-profiles/` and `.atria-profile/` must be git-ignored.
- This endpoint is a **dashboard (admin) route** and sits behind the dashboard password,
  like every other admin endpoint. It never touches `/v1/*`.

## Failure handling

Accounts are independent: one failure never aborts the run. The job continues to the
next account and records the reason, so a 100-account import of which 12 fail still
yields 88 working accounts. The user re-runs only the failed lines.

## Acceptance criteria

1. Pasting N `email|password` lines and clicking Start creates N accounts, each with a
   distinct API key.
2. Every created account's key is verified to start with `atr_` before saving.
3. An account whose Google login needs manual verification is reported as
   `google_verification_required` and does not create a database row.
4. Re-running with an already-imported email reports `Account already exists` and
   changes nothing unless force is set.
5. Two accounts in the same run end up with **different** keys — proving profile
   isolation.
6. `bun run typecheck` and `bun test test/` pass.

## Open questions

- Google's sign-in DOM is not under our control and changes without notice. The
  selectors for the Google flow (email field, password field, Next button) are the most
  brittle part of this design and are isolated in one place so they can be patched
  quickly. Expect occasional maintenance.
- Google may rate-limit or challenge a burst of sign-ins from one IP even though no
  SMS is required. The serial design mitigates this but does not eliminate it.
