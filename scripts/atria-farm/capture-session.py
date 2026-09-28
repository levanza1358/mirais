#!/usr/bin/env python3
"""
Atria session-cookie capturer.

Atria's console (`https://api.atria-asi.ai/console`) is the only place the
lifetime token balance is exposed, and it is guarded by a Logto session cookie
that is `HttpOnly` — unreadable from page JavaScript and impossible to fetch
headlessly because the sign-in form is protected by Aliyun Captcha.

Rather than asking the operator to copy the cookie out of devtools for every
account, this script drives a **persistent Camoufox profile**. The operator
signs in once, the profile keeps the session, and every later run silently
harvests a fresh cookie straight from the browser cookie jar. Nothing is typed,
nothing is copied.

Modes
-----
  --capture          Harvest cookies only. If the stored profile is already
                     signed in this finishes in a couple of seconds with no UI.
                     If it is not signed in the browser opens so the operator
                     can do it once; the session is then saved for next time.
  --check            Harvest cookies and, for each, probe `/console` to confirm
                     the session is still valid. Never opens a visible window
                     unless `--headed` is passed.

Output (JSON on stdout)
-----------------------
  {
    "success": true,
    "cookies": ["session=...; _c_WBKFRo=..."],   # ready for the Cookie header
    "expires_at": "2026-09-28T12:00:00Z" | null,
    "signed_in": true,
    "error": null
  }

Exit codes: 0 success, 1 failure (error string is still emitted as JSON).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

# Camoufox prints an ASCII-art banner containing box-drawing characters when it
# launches. On Windows the console defaults to cp1252, so that print raises
# UnicodeEncodeError *inside the child process* and the browser dies instantly
# with `exitCode=0` — which Playwright reports only as the opaque "Failed to
# launch the browser process". Force UTF-8 before anything is imported.
os.environ.setdefault("PYTHONUTF8", "1")
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except (AttributeError, ValueError):  # pragma: no cover - non-reconfigurable stream
        pass

CONSOLE_URL = "https://api.atria-asi.ai/console"
SIGN_IN_URL = "https://api.atria-asi.ai/console"

# Cookies that make up the authenticated console session.
#
# Verified against a live signed-in profile (see docs/10 \"Session cookies\"): the
# signed-in signal is the Logto session cookie `logto_<appId>`. There is no cookie
# named `session`, and the Aliyun WAF token `_c_WBKFRo` (scoped to `.atria-asi.ai`)
# must also be forwarded or `/console` returns 307. Do not trim the header down to
# the session cookie alone — the WAF checks both together.
LOGTO_APP_ID = "bldfnpl1bq5fekc85mcxi"
SESSION_COOKIE_NAMES = (f"logto_{LOGTO_APP_ID}", "_c_WBKFRo")
ATRIA_COOKIE_DOMAIN_TOKEN = "atria"


def emit(payload: dict[str, Any], code: int = 0) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    raise SystemExit(code)


def log(message: str) -> None:
    """Progress goes to stderr so stdout stays pure JSON."""
    sys.stderr.write(f"{message}\n")
    sys.stderr.flush()


def profile_dir() -> Path:
    root = Path(__file__).resolve().parent.parent.parent
    target = Path(os.environ.get("ATRIA_PROFILE_DIR", root / ".atria-profile"))
    target.mkdir(parents=True, exist_ok=True)
    return target


def load_camoufox():
    """Import Camoufox, letting the package resolve its own install directory.

    Do **not** assign `camoufox.pkgman.INSTALL_DIR`. That attribute drives the
    *install root* (browsers/, config.json, repo_cache.json) and the library
    also calls `shutil.rmtree(INSTALL_DIR)` to clean stale data. Overriding it
    with a directory that merely mirrors the browser payload makes Playwright
    launch a path it cannot resolve, and `camoufox.exe` exits 0 immediately with
    the opaque "Failed to launch the browser process". Verified by experiment:
    same build, only difference is the override, and only the override fails.

    Run `python -m camoufox fetch` to install, then this just works.
    """
    try:
        from camoufox.sync_api import Camoufox  # type: ignore

        return Camoufox
    except ImportError:
        log("[ERROR] Camoufox is not installed. Run: pip install -r scripts/atria-farm/requirements.txt && python -m camoufox fetch")
        emit({"success": False, "cookies": [], "signed_in": False, "error": "camoufox_not_installed"}, 1)
    except Exception as error:  # noqa: BLE001 - misconfiguration must not look like a missing package
        log(f"[ERROR] Camoufox failed to initialise: {error}")
        emit({"success": False, "cookies": [], "signed_in": False, "error": f"camoufox_init_failed: {error}"}, 1)


def has_session_cookie(cookies: list[dict[str, Any]]) -> bool:
    """True once the Logto session cookie exists (the only signed-in signal).

    `_c_WBKFRo` is issued *before* login by the WAF, so it must never be used as
    the signal on its own; matching the Logto cookie is sufficient and precise.
    """
    names = {c.get("name") for c in cookies}
    return f"logto_{LOGTO_APP_ID}" in names


def build_cookie_header(cookies: list[dict[str, Any]]) -> list[str]:
    """Return the cookie header(s) worth persisting, longest-lived first."""
    if not has_session_cookie(cookies):
        return []
    # Forward *every* Atria-scoped cookie (including the `.atria-asi.ai` WAF
    # token) — filtering to the session cookie alone yields a 307 from the WAF.
    wanted = [c for c in cookies if c.get("value")
              and ATRIA_COOKIE_DOMAIN_TOKEN in c.get("domain", "")]
    if not wanted:
        return []
    seen: dict[str, str] = {}
    for cookie in wanted:
        seen[cookie["name"]] = cookie["value"]
    header = "; ".join(f"{name}={value}" for name, value in seen.items())
    return [header]


def latest_expiry(cookies: list[dict[str, Any]]) -> str | None:
    """Report the Logto session's expiry, ignoring the short-lived WAF token."""
    session = [c for c in cookies if c.get("name") == f"logto_{LOGTO_APP_ID}"]
    pool = session or cookies
    stamps = [float(c["expires"]) for c in pool if c.get("expires") and float(c["expires"]) > 0]
    if not stamps:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(max(stamps)))


def harvest(context, *, allow_ui: bool) -> dict[str, Any]:
    """Read the cookie jar, optionally opening the browser for a first sign-in."""
    cookies = context.cookies()
    if has_session_cookie(cookies):
        log("[ok] Reusing the saved Atria session from the persistent profile.")
        return {"success": True, "cookies": build_cookie_header(cookies), "signed_in": True,
                "expires_at": latest_expiry(cookies), "error": None}

    if not allow_ui:
        return {"success": False, "cookies": [], "signed_in": False, "expires_at": None,
                "error": "not_signed_in"}

    log("[..] No saved session. Opening the Atria console — please sign in once.")
    page = context.new_page()
    page.goto(SIGN_IN_URL, wait_until="domcontentloaded", timeout=60_000)

    # Poll the cookie jar instead of scraping the DOM: the session cookie is
    # HttpOnly, so only the jar reveals a successful login.
    deadline = time.time() + 300
    while time.time() < deadline:
        time.sleep(2)
        cookies = context.cookies()
        if has_session_cookie(cookies):
            log("[ok] Sign-in detected — session saved for future runs.")
            page.close()
            return {"success": True, "cookies": build_cookie_header(cookies), "signed_in": True,
                    "expires_at": latest_expiry(cookies), "error": None}
    page.close()
    return {"success": False, "cookies": [], "signed_in": False, "expires_at": None,
            "error": "sign_in_timeout"}


def verify(header: str) -> bool:
    """Probe `/console` with the harvested cookie to prove it actually works."""
    import urllib.request

    request = urllib.request.Request(
        CONSOLE_URL,
        headers={
            "cookie": header,
            "accept": "text/html,application/xhtml+xml",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read().decode("utf-8", "replace")
            return response.status == 200 and "token_quota" in body
    except Exception:  # noqa: BLE001 - any failure means "not usable"
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture the Atria console session cookie.")
    parser.add_argument("--capture", action="store_true", help="Harvest the cookie (opens the browser only on first use).")
    parser.add_argument("--check", action="store_true", help="Harvest and verify the cookie against the console.")
    parser.add_argument("--headed", action="store_true", help="Force a visible browser window.")
    parser.add_argument("--timeout", type=int, default=300, help="Seconds to wait for a first sign-in.")
    args = parser.parse_args()

    allow_ui = args.headed or not args.check
    Camoufox = load_camoufox()

    try:
        with Camoufox(headless=not allow_ui, persistent_context=True,
                      user_data_dir=str(profile_dir()), humanize=True) as context:
            result = harvest(context, allow_ui=allow_ui)
    except Exception as error:  # noqa: BLE001 - surface any browser failure as JSON
        emit({"success": False, "cookies": [], "signed_in": False, "expires_at": None,
              "error": f"browser_error: {error}"}, 1)

    if result.get("success") and args.check and result["cookies"]:
        result["verified"] = verify(result["cookies"][0])
        if not result["verified"]:
            result["success"] = False
            result["error"] = "cookie_rejected"

    log(json.dumps({**result, "cookies": [f"{len(c)} chars" for c in result.get("cookies", [])]}))
    emit(result, 0 if result.get("success") else 1)


if __name__ == "__main__":
    main()
