#!/usr/bin/env python3
"""
Atria account auto-login (Google) → API key.

Signs a single Google-backed account in to the Atria console and creates a fresh
API key. The full key value is only ever visible once, at creation, so it is
captured the moment the dialog renders it.

See docs/10-atria-auto-login.md for the full design.

Usage
-----
  python login-account.py --email a@b.com --password secret \
      --profile .atria-profiles/abc123 [--headed]

Output (single JSON object on stdout)
-------------------------------------
  {
    "success": true,
    "email": "a@b.com",
    "api_key": "atr_XXXX",
    "error": null
  }

Progress goes to stderr so stdout stays pure JSON. Exit code 0 on success, 1 on
failure (the error object is still emitted).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

# Camoufox prints an ASCII-art banner with box-drawing characters. On Windows the
# console defaults to cp1252, so that print raises UnicodeEncodeError inside the
# child process and the browser dies instantly with exitCode=0 — which Playwright
# reports only as the opaque "Failed to launch the browser process". Force UTF-8
# before anything else runs. (Same hardening as capture-session.py; do not remove.)
os.environ.setdefault("PYTHONUTF8", "1")
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except (AttributeError, ValueError):  # pragma: no cover - non-reconfigurable stream
        pass

KEYS_URL = "https://api.atria-asi.ai/console/keys"
CONSOLE_URL = "https://api.atria-asi.ai/console"

# The API key is the only credential Mirais needs. The console session cookie
# (which would enable quota scraping) is deliberately NOT captured: the extra
# cookie plumbing proved brittle and the key alone is enough to route requests.

# ── Google sign-in selectors ──
# Google's DOM is not under our control and changes without notice. Every
# brittle selector is kept here so a break can be patched in one place.
#
# Google renders a decoy, hidden <input type="password" name="hiddenPassword">
# (aria-hidden="true", tabindex="-1") alongside the real one. A naive
# `input[type="password"]` matches the decoy and then waits forever for it to
# become visible — so the password selectors must exclude every hidden variant.
#
# The identifier (email) box is *not* `type="email"` on this Google build: it is
# `type="text"` with id="identifierId" and name="YPqjbf". A sibling decoy text
# input (id="ca") also exists, so we must anchor on the real ids first and only
# fall back to the looser attributes. Verified against a live captured DOM
# (see docs/10-atria-auto-login.md "Debugging the Google form").
GOOGLE_EMAIL_INPUTS = (
    '#identifierId',
    'input[name="identifier"]',
    'input[type="email"]',
    'input[name="YPqjbf"]',
)
GOOGLE_PASSWORD_INPUTS = (
    'input[name="Passwd"][type="password"]',
    'input[type="password"]:not([aria-hidden="true"])',
    'input[type="password"]',
)
# Each selector is tried in order; the first visible match wins. The email step
# lives in #identifierNext and the password step in #passwordNext; the generic
# text fallbacks keep us alive if Google renames those containers.
GOOGLE_NEXT_BUTTONS = (
    "#identifierNext button",
    "#passwordNext button",
    'button[jsname="V67aGc"]',
    'button:has-text("Next")',
    'div[role="button"]:has-text("Next")',
)


def emit(payload: dict[str, Any], code: int = 0) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    raise SystemExit(code)


def log(message: str) -> None:
    """Progress goes to stderr so stdout stays pure JSON."""
    sys.stderr.write(f"{message}\n")
    sys.stderr.flush()


def fail(error: str, *, email: str) -> None:
    """Emit a stable machine-readable failure object and exit non-zero."""
    emit({"success": False, "email": email, "api_key": None, "error": error}, 1)


def load_camoufox():
    """Import Camoufox, letting the package resolve its own install directory.

    Do **not** assign `camoufox.pkgman.INSTALL_DIR`; see capture-session.py for the
    experiment that shows why an override makes the launch fail opaquely.
    """
    try:
        from camoufox.sync_api import Camoufox  # type: ignore

        return Camoufox
    except ImportError:
        fail("camoufox_not_installed", email="")
    except Exception as error:  # noqa: BLE001 - misconfiguration must not look like a missing package
        log(f"[ERROR] Camoufox failed to initialise: {error}")
        fail(f"camoufox_init_failed: {error}", email="")


def dump_debug(page, profile: Path, tag: str) -> None:
    """Write a screenshot + DOM dump so a production failure can be inspected.

    Details are written to the per-account profile's `debug/` folder and the
    location is logged, so a failed real run is as debuggable as _debug-google.py
    without re-driving the whole flow.
    """
    out_dir = profile / "debug"
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            page.screenshot(path=str(out_dir / f"{tag}.png"), full_page=True)
        except Exception:  # noqa: BLE001 - screenshot is best-effort
            pass
        try:
            (out_dir / f"{tag}.html").write_text(page.content(), encoding="utf-8")
        except Exception:  # noqa: BLE001 - DOM dump is best-effort
            pass
        log(f"[..] Wrote debug artifacts to {out_dir / tag}.* (url={page.url})")
    except Exception as error:  # noqa: BLE001 - never let debugging mask the real error
        log(f"[WARN] Could not write debug artifacts: {error}")


def visible_locator(page, selectors: tuple[str, ...]):
    """Return the first selector that resolves to a *visible* element, else None.

    Unlike `page.fill`, this never latches onto a hidden decoy node — Google keeps
    an invisible password input on the identifier page to trip up scrapers.
    """
    for selector in selectors:
        try:
            locator = page.locator(selector)
            for index in range(min(locator.count(), 5)):
                candidate = locator.nth(index)
                if candidate.is_visible():
                    return candidate
        except Exception:  # noqa: BLE001 - selector did not match this layout
            continue
    return None


def wait_for_visible(page, selectors: tuple[str, ...], *, timeout: float = 45.0):
    """Poll until one of the selectors has a visible element, or time out."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        element = visible_locator(page, selectors)
        if element is not None:
            return element
        time.sleep(0.25)
    return None


def fill_visible_field(page, selectors: tuple[str, ...], value: str, *,
                       timeout: float = 45.0, label: str = "field") -> bool:
    """Type `value` into the first *visible* match, re-resolving on every attempt.

    Google re-renders its forms between steps, so a locator captured by
    `wait_for_visible` can turn stale (hidden or detached) before `.click()` lands.
    This loop re-resolves visibility plus performs click → clear → type → verify in
    one pass, retrying the whole sequence so one bad render does not fail the run.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        element = visible_locator(page, selectors)
        if element is not None:
            try:
                element.click(timeout=5_000)
                element.fill("")
                element.type(value, delay=20)
                actual = (element.input_value() or "").strip()
                if actual == value.strip():
                    return True
                log(f"[WARN] {label} did not retain the typed value; retrying")
            except Exception as error:  # noqa: BLE001 - element went stale mid-entry
                log(f"[WARN] {label} entry failed ({error}); retrying")
        time.sleep(0.4)
    return False


def wait_for_host_change(page, previous_host: str, *, timeout: float = 45.0) -> str:
    """Wait until the page leaves the given host (e.g. leaves accounts.google.com)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            from urllib.parse import urlparse

            host = urlparse(page.url).hostname or ""
        except Exception:  # noqa: BLE001 - page may be mid-navigation
            host = ""
        if host and host != previous_host:
            return host
        time.sleep(0.25)
    return previous_host


def sign_in_with_google(page, email: str, password: str) -> str | None:
    """Drive the Google sign-in form. Returns None on success, else an error code.

    Google renders the email and password steps as two separate pages. The email
    step *also* ships a hidden password input, so the password field can only be
    located after the page has actually navigated away from the identifier screen.
    """
    from urllib.parse import urlparse

    log("[..] Signing in with Google…")
    try:
        # The Atria console shows a "Continue with Google" button first.
        for label in ("Continue with Google", "Sign in with Google", "Google"):
            button = page.get_by_role("button", name=label)
            if button.count() and button.first.is_visible():
                button.first.click()
                log(f"[..] Clicked '{label}'")
                break
        else:
            link = page.get_by_role("link", name="Google")
            if link.count() and link.first.is_visible():
                link.first.click()
                log("[..] Clicked Google link")

        # ── Email → Next ──
        # Google sometimes shows an account chooser (a list of signed-in accounts)
        # before the identifier form; pick the "use another account" row if so.
        dismiss_google_account_chooser(page)

        if not fill_visible_field(page, GOOGLE_EMAIL_INPUTS, email,
                                  timeout=45, label="identifier"):
            return detect_google_block(page) or "google_form_failed"
        click_first(page, GOOGLE_NEXT_BUTTONS)
        log("[..] Submitted email")

        # Google may reject the address before ever asking for a password.
        blocked = detect_google_block(page)
        if blocked is not None:
            return blocked

        # ── Password → Next ──
        # The identifier URL keeps its path but the DOM swaps to the password form,
        # so wait for a *visible* password input rather than for a navigation event.
        # The hidden decoy password input also exists on the identifier page, which
        # is why visibility (not a plain `fill`) is mandatory here.
        if not fill_visible_field(page, GOOGLE_PASSWORD_INPUTS, password,
                                  timeout=45, label="password"):
            blocked = detect_google_block(page)
            if blocked is not None:
                return blocked
            log("[WARN] The password field never became visible")
            return "google_form_failed"

        click_first(page, ("#passwordNext button", *GOOGLE_NEXT_BUTTONS))
        log("[..] Submitted password")

        # Give Google a moment; a wrong password re-renders the same form with an error.
        time.sleep(2)
        blocked = detect_google_block(page)
        if blocked is not None:
            return blocked

        # ── OAuth consent + redirect back to Atria ──
        # After a correct password Google shows its OAuth consent screen
        # ("atria-asi.ai wants access…") headed by a localised Continue button
        # (English "Continue", Indonesian "Lanjutkan"). A brand-new account first
        # detours through the Workspace Terms-of-Service speedbump, and it may
        # also skip straight to a SetSID interstitial. Either way the flow only
        # finishes once the browser is back on an atria-asi.ai host, which is
        # where Logto exchanges the Google identity for a console session.
        # Navigating away before that is what produced `not_signed_in` in testing.
        accept_google_consent(page, timeout=90)
        if _host_of(page.url) and not _is_google_host(_host_of(page.url)):
            log("[ok] Returned to Atria after Google sign-in.")
        elif not wait_for_app_or_console(page, timeout=45):
            log("[WARN] The browser did not return to an Atria host after sign-in.")
    except Exception as error:  # noqa: BLE001 - any DOM surprise is a login failure
        log(f"[WARN] Google form interaction failed: {error}")
        return detect_google_block(page) or "google_form_failed"
    return None


# Localised labels for Google's OAuth consent screen. The account's UI language
# follows the browser/profile locale, so both English and Indonesian are listed.
GOOGLE_CONSENT_LABELS = ("Continue", "Lanjutkan", "Allow", "Izinkan", "Setuju")

# Brand-new Google accounts are first routed through the Workspace "speedbump"
# Terms of Service page (`/signin/speedbump/workspacetermsofservice`). It is not
# the OAuth consent screen, so its confirm button uses different labels and sits
# behind a scroll. Both English and Indonesian are listed.
GOOGLE_TOS_LABELS = (
    "I understand", "Saya mengerti", "Saya paham", "Saya setuju",
    "I agree", "Setuju", "Agree", "Accept", "Terima",
)
GOOGLE_TOS_MARKERS = ("speedbump", "termsofservice", "workspacetermsofservice")

# Every host suffix that means "we are still inside Google's OAuth flow". Google
# serves the flow from country domains (google.co.id, google.co.uk, …) and drops
# the browser onto interstitial pages such as `/accounts/SetSID`, both of which
# briefly look like "we left Google" if you only check for `google.com`. Treating
# those as the end of the flow navigates away before Logto's callback runs, so the
# session never completes — the exact bug this guards against.
GOOGLE_HOST_SUFFIXES = (
    "google.com", "google.co.id", "google.co.uk", "google.co.jp",
    "google.de", "google.fr", "googleapis.com", "gstatic.com",
    "googleusercontent.com", "googleusercontent.com", "youtube.com",
)
APP_HOST_SUFFIX = "atria-asi.ai"


def _host_of(url: str) -> str:
    from urllib.parse import urlparse

    try:
        return urlparse(url).hostname or ""
    except Exception:  # noqa: BLE001 - page may be mid-navigation
        return ""


def _is_google_host(host: str) -> bool:
    return any(host == suffix or host.endswith("." + suffix) for suffix in GOOGLE_HOST_SUFFIXES)


def _on_tos_page(page) -> bool:
    """Whether the browser is on Google's Workspace Terms-of-Service speedbump."""
    try:
        url = (page.url or "").lower()
    except Exception:  # noqa: BLE001 - page may be mid-navigation
        return False
    return any(marker in url for marker in GOOGLE_TOS_MARKERS)


def accept_google_tos(page) -> bool:
    """Scroll and confirm Google's Workspace Terms-of-Service speedbump.

    The ToS page hides its confirm button at the bottom of a scrollable card, so
    it must be scrolled into view before the click. Returns True if a button was
    clicked; False when the page simply was not the ToS speedbump.
    """
    if not _on_tos_page(page):
        return False
    log("[..] On the Google Workspace Terms-of-Service page — confirming.")
    for label in GOOGLE_TOS_LABELS:
        try:
            button = page.get_by_role("button", name=label, exact=False)
            if not button.count():
                continue
            target = button.first
            try:
                target.scroll_into_view_if_needed(timeout=5_000)
            except Exception:  # noqa: BLE001 - some buttons are already visible
                pass
            if target.is_visible():
                target.click()
                log(f"[..] Accepted Google Terms of Service via '{label}'")
                return True
        except Exception:  # noqa: BLE001 - label simply not present
            continue
    # A click may already have advanced the page to the consent screen between
    # the ToS check and this loop; that is progress, not a failure.
    if not _on_tos_page(page):
        return True
    log("[WARN] On the ToS page but no confirm button matched.")
    return False


def accept_google_consent(page, *, timeout: float = 45.0) -> bool:
    """Accept Google's OAuth consent screen and wait for the redirect back to Atria.

    Returns True if a consent button was clicked. Polls because the screen is
    rendered client-side a moment after the password is accepted, and because the
    redirect chain (consent → SetSID interstitial → Logto callback → app) can take
    several seconds on a cold profile. A brand-new account first detours through
    the Workspace Terms-of-Service speedbump, which is confirmed as it appears.
    """
    deadline = time.time() + timeout
    last_host = ""
    clicked = False
    while time.time() < deadline:
        host = _host_of(page.url)
        if host != last_host:
            log(f"[..] OAuth wait: on host {host or '(unknown)'}")
            last_host = host
        # Only Google hosts carry the consent screen; once the browser is on the
        # Atria app host the OAuth callback has completed.
        if host and not _is_google_host(host):
            log("[..] Reached the application host — OAuth flow complete.")
            return clicked
        # The Workspace ToS speedbump precedes the consent screen for new accounts.
        if accept_google_tos(page):
            clicked = True
            time.sleep(1)
            continue
        for label in GOOGLE_CONSENT_LABELS:
            try:
                button = page.get_by_role("button", name=label, exact=True)
                if button.count() and button.first.is_visible():
                    button.first.click()
                    log(f"[..] Accepted Google consent via '{label}'")
                    clicked = True
                    break
            except Exception:  # noqa: BLE001 - label simply not present
                continue
        time.sleep(0.5)
    log("[WARN] The OAuth redirect did not reach the application host in time.")
    return clicked


def wait_for_app_or_console(page, *, timeout: float = 60.0) -> bool:
    """Wait until the browser is on an Atria host after the Google redirect."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        host = _host_of(page.url)
        if host and APP_HOST_SUFFIX in host:
            return True
        time.sleep(0.5)
    return False


def _on_keys_page(page) -> bool:
    """Whether the browser has actually landed on the signed-in keys page.

    Logto bounces an unauthenticated visit back to a `sign-in`/`sign-up` route on
    the same atria-asi.ai host, so a host check alone is not enough — the path
    has to match too.
    """
    try:
        url = page.url or ""
    except Exception:  # noqa: BLE001 - page may be mid-navigation
        return False
    return "/console/keys" in url


def detect_google_block(page) -> str | None:
    """Return a specific error code if Google is asking for something we cannot do.

    A brand-new account shows an "accept terms" screen, which *is* automatable and
    handled separately by `accept_terms_if_present`. Anything else — captcha, 2FA,
    "verify it's you", device approval — we surface honestly instead of hanging.
    """
    try:
        body = (page.inner_text("body") or "").lower()
    except Exception:  # noqa: BLE001 - page may be navigating
        return None
    for needle, code in (
        ("couldn't find your google account", "bad_credentials"),
        ("wrong password", "bad_credentials"),
        ("verify it's you", "google_verification_required"),
        ("2-step verification", "google_verification_required"),
        ("enter a code", "google_verification_required"),
        ("unusual activity", "google_verification_required"),
        ("recaptcha", "google_verification_required"),
        ("try again later", "google_verification_required"),
    ):
        if needle in body:
            log(f"[!] Google blocked the sign-in: {needle}")
            return code
    return None


def accept_terms_if_present(page) -> bool:
    """Click through the 'accept terms' screen shown to brand-new accounts."""
    try:
        body = (page.inner_text("body") or "").lower()
    except Exception:  # noqa: BLE001 - page may be navigating
        return False
    if not any(needle in body for needle in ("terms of service", "accept the terms", "agree to the", "welcome to atria")):
        return False
    for label in ("Accept", "I agree", "Agree", "Continue", "Get started"):
        button = page.get_by_role("button", name=label)
        if button.count() and button.first.is_visible():
            button.first.click()
            log(f"[..] Accepted terms via '{label}'")
            return True
    return False


def click_first(page, selectors: tuple[str, ...]) -> bool:
    """Click the first selector that resolves to a visible element."""
    for selector in selectors:
        try:
            element = page.locator(selector).first
            if element.count() and element.is_visible():
                element.click()
                return True
        except Exception:  # noqa: BLE001 - selector simply did not match this layout
            continue
    return False


# The Google account chooser lists previously-signed-in accounts. We always want
# the "use another account" row so the driver types the supplied credentials
# rather than silently reusing a stale profile session.
GOOGLE_CHOOSER_LABELS = (
    "Use another account",
    "Gunakan akun lain",
    "Add another account",
    "Tambahkan akun lain",
)


def dismiss_google_account_chooser(page, *, timeout: float = 8.0) -> bool:
    """If Google shows the account chooser, pick 'use another account'.

    Only ever triggers on the account-chooser screen; returns False immediately
    when the identifier form is already present.
    """
    from urllib.parse import urlparse

    if "accountchooser" not in (urlparse(page.url).path or ""):
        # Not the chooser; the identifier form may still be a click away, so give
        # the caller the fast path.
        return False
    deadline = time.time() + timeout
    while time.time() < deadline:
        for label in GOOGLE_CHOOSER_LABELS:
            try:
                element = page.get_by_text(label, exact=True)
                if element.count() and element.first.is_visible():
                    element.first.click()
                    log(f"[..] Account chooser: clicked '{label}'")
                    return True
            except Exception:  # noqa: BLE001 - label simply not present
                continue
        # A row whose accessible name contains the target email.
        time.sleep(0.4)
    return False


def create_api_key(page, key_name: str) -> str | None:
    """Create a key and read its full value from the dialog.

    The console only ever renders the *prefix* of an existing key, so the value
    must be captured here, the single moment it exists in the DOM.
    """
    log("[..] Creating API key…")
    # Verified against the live keys page (docs/10): the opener is a bare
    # <button aria-haspopup="dialog">+ Create key</button> with NO class, so
    # anchoring on a `.key-create` wrapper (as an earlier revision did) never
    # matched. `:has-text` tolerates the "+" glyph and leading whitespace.
    if not click_first(page, ('button[aria-haspopup="dialog"]:has-text("Create key")',
                              'button:has-text("+ Create key")',
                              'button:has-text("Create key")')):
        log("[WARN] Could not find the Create key button")
        return None

    try:
        page.wait_for_selector("dialog.key-create-dialog", timeout=15_000, state="visible")
    except Exception:  # noqa: BLE001 - dialog never opened
        log("[WARN] Create-key dialog did not open")
        return None

    try:
        name_input = page.locator('dialog.key-create-dialog input[maxlength="64"]').first
        if not name_input.count():
            name_input = page.locator("dialog.key-create-dialog input[type='text']").first
        name_input.fill(key_name)
    except Exception as error:  # noqa: BLE001 - input variant we did not anticipate
        log(f"[WARN] Could not fill the key name: {error}")

    if not click_first(page, ("dialog.key-create-dialog button.key-dialog-primary",
                              'dialog.key-create-dialog button[type="submit"]')):
        log("[WARN] Could not submit the Create key form")
        return None

    # The freshly-created secret is shown once, usually as selectable text or an
    # input value. Look for anything starting with the known key prefix.
    deadline = time.time() + 20
    while time.time() < deadline:
        key = read_full_key(page)
        if key:
            log("[ok] Captured the full API key.")
            return key
        time.sleep(0.5)
    log("[WARN] The full key never appeared in the dialog")
    return None


def read_full_key(page) -> str | None:
    """Scrape a full `atr_…` key from the page, wherever it renders."""
    try:
        candidates = page.evaluate(
            """() => {
                const out = [];
                for (const el of document.querySelectorAll('input, textarea, code')) {
                    const v = el.value || el.textContent || '';
                    if (v && v.includes('atr_')) out.push(v.trim());
                }
                const text = document.body ? document.body.innerText : '';
                for (const m of text.matchAll(/atr_[A-Za-z0-9_-]{16,}/g)) out.push(m[0]);
                return out;
            }"""
        )
    except Exception:  # noqa: BLE001 - page may be mid-navigation
        return None
    for value in candidates or []:
        match = _extract_key(value)
        if match:
            return match
    return None


def _extract_key(value: str) -> str | None:
    """Return a plausible full key from a string, ignoring masked prefixes."""
    import re

    # Prefer a long, unbroken token; a masked value contains the bullet char and
    # would not match the character class anyway.
    for match in re.finditer(r"atr_[A-Za-z0-9_-]{16,}", value):
        candidate = match.group(0).rstrip("_")
        if len(candidate) >= 20:
            return candidate
    return None


def run(args) -> None:
    Camoufox = load_camoufox()
    profile = Path(args.profile)
    profile.mkdir(parents=True, exist_ok=True)

    try:
        with Camoufox(headless=not args.headed, persistent_context=True,
                      user_data_dir=str(profile), humanize=True) as context:
            page = context.pages[0] if context.pages else context.new_page()

            # Reuse an existing session when the profile is already signed in.
            # Signed-in is judged purely by where the keys page lands us: no
            # cookie inspection is involved anywhere in this driver.
            page.goto(KEYS_URL, wait_until="domcontentloaded", timeout=60_000)
            time.sleep(2)
            if not _on_keys_page(page):
                error = sign_in_with_google(page, args.email, args.password)
                if error:
                    fail(error, email=args.email)
                # After the Google round-trip the browser is on an atria-asi.ai
                # host (Logto sign-in or the console). Wait for the app host, then
                # land on the keys page to create the key.
                log(f"[..] Post-login URL: {page.url}")
                wait_for_app_or_console(page, timeout=30)
                try:
                    page.goto(KEYS_URL, wait_until="domcontentloaded", timeout=60_000)
                except Exception as goto_error:  # noqa: BLE001
                    log(f"[WARN] Navigating to the keys page failed: {goto_error}")
                time.sleep(2)
                if not _on_keys_page(page):
                    dump_debug(page, Path(args.profile), "post-login-not-signed-in")
                    fail("not_signed_in", email=args.email)
                log("[ok] Signed in to the Atria console.")

            accept_terms_if_present(page)
            time.sleep(1)

            block = detect_google_block(page)
            if block:
                fail(block, email=args.email)

            api_key = create_api_key(page, args.key_name)
            if not api_key:
                fail("key_not_captured", email=args.email)

            emit({"success": True, "email": args.email, "api_key": api_key,
                  "error": None}, 0)
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - surface any browser failure as JSON
        fail(f"browser_error: {error}", email=args.email)


def main() -> None:
    parser = argparse.ArgumentParser(description="Atria account auto-login (Google) → API key.")
    parser.add_argument("--email", required=True, help="Google account email")
    parser.add_argument("--password", required=True, help="Google account password")
    parser.add_argument("--profile", required=True, help="Per-account Camoufox profile directory")
    parser.add_argument("--key-name", default=None, help="Name for the created API key (default mirais-<epoch>)")
    parser.add_argument("--headed", action="store_true", help="Show the browser window (default: headless)")
    parser.add_argument("--headless", action="store_true", help="Force headless mode (overrides --headed)")
    args = parser.parse_args()
    if args.headless:
        args.headed = False
    if not args.key_name:
        args.key_name = f"mirais-{int(time.time())}"
    run(args)


if __name__ == "__main__":
    main()
