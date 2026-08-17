"""
xAI (Grok) Auto Register Bot
============================
Alur:
1. Load config dari Mirais settings (via env atau args)
2. Generate random email @domain
3. Buka x.ai signup via Camoufox (disimpan di .camoufox/)
4. Register dengan email + password
5. Ambil OTP dari Gmail IMAP
6. Input OTP → complete registration
7. Authorize OAuth device code flow
8. Simpan tokens ke output JSON

Usage:
    python farm.py --output result.json [--config config.json]
"""

import argparse
import json
import os
import random
import re
import string
import sys
import time
from datetime import datetime
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv

# Load .env from project root
load_dotenv(Path(__file__).parent.parent.parent / ".env")

# ============================================================
# CONFIG
# ============================================================
# Camoufox cache directory (installation-local)
CAMOUFOX_CACHE = Path(os.environ.get("CAMOUFOX_CACHE_DIR", Path(__file__).parent.parent.parent / ".camoufox"))
CAMOUFOX_CACHE.mkdir(exist_ok=True)
os.environ["CAMOUFOX_CACHE_DIR"] = str(CAMOUFOX_CACHE)

# OAuth Device Code Config (from 9router)
XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code"
XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token"
XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write"
XAI_BASE_URL = "https://cli-chat-proxy.grok.com/v1"

# Default config (overridden by --config or env)
DEFAULT_CONFIG = {
    "enabled": False,
    "gmail_username": "",
    "gmail_app_password": "",
    "email_domain": "levanza.my.id",
    "headless": False,
    "otp_check_interval": 5,
    "otp_max_retries": 12,
    "account_password": "XaiFarm2024!",
}


def load_config(config_path: str = None) -> dict:
    """Load config from JSON file or environment."""
    config = DEFAULT_CONFIG.copy()

    # Load from JSON file if provided
    if config_path and Path(config_path).exists():
        with open(config_path) as f:
            file_config = json.load(f)
            config.update(file_config)

    # Override with environment variables
    env_mapping = {
        "GMAIL_USERNAME": "gmail_username",
        "GMAIL_APP_PASSWORD": "gmail_app_password",
        "EMAIL_DOMAIN": "email_domain",
        "HEADLESS": "headless",
        "OTP_CHECK_INTERVAL": "otp_check_interval",
        "OTP_MAX_RETRIES": "otp_max_retries",
        "ACCOUNT_PASSWORD": "account_password",
    }

    for env_key, config_key in env_mapping.items():
        env_value = os.getenv(env_key)
        if env_value is not None:
            if config_key in ("headless",):
                config[config_key] = env_value.lower() in ("1", "true", "yes", "on")
            elif config_key in ("otp_check_interval", "otp_max_retries"):
                config[config_key] = int(env_value)
            else:
                config[config_key] = env_value

    return config


def generate_random_email(domain: str) -> str:
    """Generate random email dengan domain kustom."""
    prefix = "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
    return f"{prefix}@{domain}"


def generate_password() -> str:
    """Generate secure random password."""
    chars = string.ascii_letters + string.digits + "!@#$%"
    return "".join(random.choices(chars, k=16))


class XaiEmailReader:
    """Membaca email OTP dari Gmail via IMAP."""

    def __init__(self, username: str, app_password: str, check_interval: int = 5, max_retries: int = 12):
        self.username = username
        self.app_password = app_password.replace(" ", "")
        self.check_interval = check_interval
        self.max_retries = max_retries
        self.imap = None

    def connect(self):
        """Connect ke Gmail IMAP server."""
        import imaplib
        try:
            self.imap = imaplib.IMAP4_SSL("imap.gmail.com")
            self.imap.login(self.username, self.app_password)
            print(f"[EMAIL] Connected to Gmail as {self.username}")
        except Exception as e:
            raise Exception(
                f"Gmail login gagal. Pastikan:\n"
                f"  1. App Password benar (16 karakter tanpa spasi)\n"
                f"  2. IMAP diaktifkan di Gmail Settings\n"
                f"  3. Username benar: {self.username}\n"
                f"  Error: {e}"
            )

    def disconnect(self):
        """Disconnect dari IMAP server."""
        if self.imap:
            try:
                self.imap.logout()
            except Exception:
                pass
            print("[EMAIL] Disconnected from Gmail")

    def _decode_body(self, msg) -> str:
        """Ambil body email."""
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                content_type = part.get_content_type()
                if "attachment" not in str(part.get("Content-Disposition")):
                    try:
                        payload = part.get_payload(decode=True)
                        if payload:
                            charset = part.get_content_charset() or "utf-8"
                            decoded = payload.decode(charset, errors="ignore")
                            if content_type == "text/plain":
                                body += decoded
                            elif content_type == "text/html":
                                body += decoded
                    except Exception:
                        continue
        else:
            try:
                payload = msg.get_payload(decode=True)
                if payload:
                    charset = msg.get_content_charset() or "utf-8"
                    body = payload.decode(charset, errors="ignore")
            except Exception:
                pass
        return body

    def find_otp(self, target_email: str, timeout: int = 120) -> str | None:
        """
        Cari OTP dari email x.ai.
        Returns: OTP string atau None jika tidak ditemukan.
        """
        import email
        from email.header import decode_header

        start_time = time.time()

        while time.time() - start_time < timeout:
            try:
                self.imap.select("INBOX")
                # Search only recent xAI messages. UID ordering puts the newest message last.
                _, message_numbers = self.imap.uid("search", None, "FROM", "noreply@x.ai")
                uids = message_numbers[0].split()
                if not uids:
                    _, message_numbers = self.imap.uid("search", None, "FROM", "x.ai")
                    uids = message_numbers[0].split()

                for uid in reversed(uids[-10:]):
                    _, msg_data = self.imap.uid("fetch", uid, "(RFC822)")
                    if not msg_data or not msg_data[0]:
                        continue
                    msg = email.message_from_bytes(msg_data[0][1])

                    subject, encoding = decode_header(msg["Subject"] or "")[0]
                    if isinstance(subject, bytes):
                        subject = subject.decode(encoding or "utf-8", errors="ignore")

                    from_addr = msg.get("From", "").lower()
                    if "x.ai" not in from_addr and "xai" not in from_addr:
                        continue

                    to_addr = msg.get("To", "").lower()
                    delivered_to = msg.get("Delivered-To", "").lower()
                    if target_email.lower() not in to_addr and target_email.lower() not in delivered_to:
                        continue

                    body = self._decode_body(msg)

                    # Prefer the exact code in the subject, then the large code in the HTML body.
                    otp_match = re.search(r"\b([A-Z0-9]{3}-[A-Z0-9]{3})\b", subject or "", re.IGNORECASE)
                    if not otp_match:
                        otp_match = re.search(r"\b([A-Z0-9]{3}-[A-Z0-9]{3})\b", body, re.IGNORECASE)
                    if not otp_match:
                        otp_match = re.search(r"\b(\d{6})\b", subject or "")
                    if not otp_match:
                        otp_match = re.search(r"\b(\d{6})\b", body)
                    if otp_match:
                        otp = otp_match.group(1).upper()
                        print(f"[EMAIL] Found OTP: {otp}")
                        return otp

                    link_match = re.search(r"https?://[^\s<>\"']+verify[^\s<>\"']*", body)
                    if link_match:
                        link = link_match.group(0)
                        print(f"[EMAIL] Found verification link: {link[:50]}...")
                        return link

                print(f"[EMAIL] No OTP found yet, waiting {self.check_interval}s...")
                time.sleep(self.check_interval)

            except Exception as e:
                print(f"[EMAIL] Error checking email: {e}")
                time.sleep(self.check_interval)

        print("[EMAIL] Timeout waiting for OTP")
        return None


class XaiFarmBot:
    """Bot untuk register xAI (Grok) otomatis."""

    def __init__(self, config: dict, email: str = None, password: str = None):
        self.config = config
        self.email = email or generate_random_email(config["email_domain"])
        self.password = password or config.get("account_password") or generate_password()
        self.email_reader = XaiEmailReader(
            config["gmail_username"],
            config["gmail_app_password"],
            config["otp_check_interval"],
            config["otp_max_retries"],
        )
        self.device_code = None
        self.user_code = None
        self.access_token = None
        self.refresh_token = None

    def request_device_code(self) -> dict:
        """Request OAuth device code from x.ai."""
        import urllib.request
        import urllib.parse

        data = urllib.parse.urlencode({
            "client_id": XAI_CLIENT_ID,
            "scope": XAI_SCOPE,
        }).encode()

        req = urllib.request.Request(
            XAI_DEVICE_CODE_URL,
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )

        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode())

    def poll_token(self) -> dict:
        """Poll for OAuth token."""
        import urllib.request
        import urllib.parse

        data = urllib.parse.urlencode({
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "device_code": self.device_code,
            "client_id": XAI_CLIENT_ID,
        }).encode()

        req = urllib.request.Request(
            XAI_TOKEN_URL,
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as e:
            error_data = json.loads(e.read().decode())
            return error_data

    def run(self) -> dict:
        """Run the full registration + OAuth flow."""
        result = {
            "success": False,
            "email": self.email,
            "password": self.password,
            "access_token": None,
            "refresh_token": None,
            "error": None,
        }

        try:
            # Step 1: Request device code
            print("[STEP 1] Requesting device code...")
            device = self.request_device_code()
            self.device_code = device["device_code"]
            self.user_code = device["user_code"]
            verification_url = device["verification_uri_complete"]

            print(f"[DEVICE] User code: {self.user_code}")
            print(f"[DEVICE] Verification URL: {verification_url}")

            # Step 2: Launch browser and register
            print("[STEP 2] Launching Camoufox for registration...")
            self._run_browser_flow(verification_url)

            # Step 3: Poll for token
            print("[STEP 3] Polling for OAuth token...")
            token_result = self._poll_for_token()

            if token_result.get("access_token"):
                result["success"] = True
                result["access_token"] = token_result["access_token"]
                result["refresh_token"] = token_result.get("refresh_token")
                print(f"[SUCCESS] Access token obtained!")
            else:
                result["error"] = f"Failed to get token: {token_result}"

        except Exception as e:
            result["error"] = str(e)
            print(f"[ERROR] {e}")

        return result

    def _check_required_consents(self, page) -> None:
        """Tick any visible, unchecked consent/terms checkboxes on the page.

        xAI's sign-up form gates the submit button behind agreeing to its
        terms, and the checkbox can be a styled div or a native checkbox input.
        """
        selectors = [
            'input[type="checkbox"]',
            'input[role="checkbox"]',
            '[role="checkbox"]',
            'button[role="checkbox"]',
        ]
        for selector in selectors:
            try:
                boxes = page.locator(selector).all()
            except Exception:
                continue
            for box in boxes:
                try:
                    if not box.is_visible():
                        continue
                except Exception:
                    continue
                try:
                    if box.is_checked():
                        continue
                except Exception:
                    pass
                try:
                    box.click(timeout=2000)
                    time.sleep(0.3)
                except Exception:
                    # Styled checkbox: click the nearest label/parent.
                    try:
                        box.evaluate("el => el.click()")
                        time.sleep(0.3)
                    except Exception:
                        pass

    def _click_positive_auth_button(self, page) -> None:
        """Click the device-authorization confirmation (Allow) button.

        xAI's consent page has changed label/element over time, so this tries a
        broad set of positive labels across button, submit, and link controls.
        """
        patterns = [
            re.compile(r"^Allow$", re.IGNORECASE),
            re.compile(r"^Allow access$", re.IGNORECASE),
            re.compile(r"^Authorize$", re.IGNORECASE),
            re.compile(r"^Authorize app$", re.IGNORECASE),
            re.compile(r"^Approve$", re.IGNORECASE),
            re.compile(r"^Approve access$", re.IGNORECASE),
            re.compile(r"^Yes, allow$", re.IGNORECASE),
            re.compile(r"^Grant access$", re.IGNORECASE),
            re.compile(r"^Confirm$", re.IGNORECASE),
        ]
        for pattern in patterns:
            controls = [
                page.get_by_role("button", name=pattern),
                page.get_by_role("link", name=pattern),
            ]
            for label in ("allow", "authorize", "approve", "grant", "confirm"):
                controls.append(page.locator(f'input[type="submit"][value*="{label}" i]'))
            for control in controls:
                try:
                    control.first.wait_for(state="visible", timeout=4000)
                    control.first.click(timeout=4000)
                    return
                except Exception:
                    continue
        # Fallback: click any visible button whose accessible name contains a
        # positive keyword, avoiding deny actions.
        deny_keywords = ("deny", "cancel", "reject", "no", "not allow", "decline")
        try:
            buttons = page.locator("button, input[type=submit], a[role=button]").all()
        except Exception:
            raise RuntimeError("Browser closed before the device authorization confirmation")
        for btn in buttons:
            try:
                name = (btn.inner_text() or btn.get_attribute("value") or btn.get_attribute("aria-label") or "").strip()
            except Exception:
                continue
            if not name:
                continue
            lower = name.lower()
            if any(k in lower for k in deny_keywords):
                continue
            if any(k in lower for k in ("allow", "authorize", "approve", "grant", "confirm", "continue")):
                try:
                    btn.click(timeout=4000)
                    return
                except Exception:
                    continue
        raise RuntimeError("Could not find the positive device authorization confirmation button")

    def _ensure_logged_in(self, page, force: bool = False) -> None:
        """Ensure the browser session is authenticated, signing in if necessary.

        The xAI sign-up flow sometimes persists a session and sometimes not.
        We first probe /account: if the session is already authenticated we
        keep it (re-login can actually break a valid session). Only when the
        probe bounces to sign-in — or `force` is set — do we re-authenticate.
        """
        if not force:
            page.goto("https://accounts.x.ai/account", wait_until="networkidle", timeout=30000)
            time.sleep(2)
            if "sign-in" not in page.url and "login" not in page.url.lower():
                print("[BROWSER] Session is logged in.")
                return

        print("[BROWSER] Signing in with email...")
        page.goto("https://accounts.x.ai/sign-in", wait_until="networkidle", timeout=30000)
        time.sleep(2)
        email_login = page.locator('button:has-text("Login with email"), button:has-text("Continue with email"), button:has-text("Email")').first
        if email_login.is_visible(timeout=5000):
            email_login.click()
            time.sleep(2)
        login_email = page.locator('input[type="email"], input[name="email"], input[autocomplete="email"]').first
        login_email.wait_for(state="visible", timeout=15000)
        login_email.fill(self.email)
        page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Next")').first.click()
        time.sleep(2)
        login_password = page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]').first
        login_password.wait_for(state="visible", timeout=15000)
        login_password.fill(self.password)
        page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Continue"), button:has-text("Log in")').first.click()
        time.sleep(4)

        # Verify the session actually stuck; retry once if it bounced to sign-in.
        if "sign-in" in page.url or "login" in page.url.lower():
            print("[BROWSER] Sign-in may not have persisted; retrying once...")
            page.goto("https://accounts.x.ai/account", wait_until="networkidle", timeout=30000)
            time.sleep(2)

    def _open_device_authorization(self, page, verification_url: str) -> None:
        """Navigate to the device consent page, signing in if bounced to login."""
        page.goto(verification_url, wait_until="networkidle", timeout=30000)
        time.sleep(2)
        if "sign-in" in page.url or "login" in page.url.lower():
            self._ensure_logged_in(page)
            page.goto(verification_url, wait_until="networkidle", timeout=30000)
            time.sleep(2)

    def _run_browser_flow(self, verification_url: str):
        """Run Camoufox browser automation."""
        try:
            import camoufox.pkgman

            camoufox.pkgman.INSTALL_DIR = CAMOUFOX_CACHE
            from camoufox.sync_api import Camoufox
        except ImportError:
            print("[WARN] Camoufox not installed, falling back to Playwright")
            self._run_playwright_flow(verification_url)
            return

        with Camoufox(headless=self.config["headless"]) as browser:
            page = browser.new_page()

            # Navigate to xAI accounts signup
            print(f"[BROWSER] Opening xAI accounts signup...")
            page.goto("https://accounts.x.ai/sign-up", wait_until="networkidle")
            time.sleep(2)

            # Choose email signup first (accounts.x.ai shows OAuth buttons before the form)
            print(f"[BROWSER] Choosing email signup...")
            email_input = page.locator('input[data-testid="email"], input[name="email"], input[type="email"], input[placeholder*="email" i]').first
            if not email_input.is_visible(timeout=3000):
                email_signup_selectors = [
                    'button:has-text("Sign up with email")',
                    'button:has-text("Sign up with Email")',
                    'button:has-text("Continue with email")',
                    'button:has-text("Email")',
                    'button:has(svg.lucide-mail)',
                ]
                clicked = False
                for selector in email_signup_selectors:
                    btn = page.locator(selector).first
                    try:
                        btn.wait_for(state="visible", timeout=5000)
                        btn.scroll_into_view_if_needed()
                        time.sleep(0.5)
                        btn.click(timeout=5000)
                        clicked = True
                        break
                    except Exception:
                        continue
                if not clicked:
                    raise RuntimeError("Could not click the xAI 'Sign up with email' button")
                time.sleep(2)

            # Fill email
            print(f"[BROWSER] Filling email: {self.email}")
            email_input.wait_for(state="visible", timeout=15000)
            email_input.fill(self.email)
            time.sleep(1)

            # Tick any consent/terms checkbox before continuing.
            self._check_required_consents(page)

            # Continue after email to reach the OTP screen
            continue_btn = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Next")').first
            if continue_btn.is_visible(timeout=5000):
                print(f"[BROWSER] Continuing to email verification...")
                continue_btn.click()
                time.sleep(2)

            # Check for OTP input
            print(f"[BROWSER] Waiting for OTP input...")
            otp_input = page.locator('input[data-input-otp="true"], input[name="code"], input[autocomplete="one-time-code"], input[name="otp"], input[placeholder*="code" i], input[placeholder*="otp" i]').first
            try:
                otp_input.wait_for(state="visible", timeout=30000)
            except Exception as error:
                # Dump the page state so we can see what xAI actually showed
                # instead of the OTP form (e.g. captcha, "already registered").
                dump_path = Path(__file__).parent.parent.parent / "data" / "xfarm-otp-debug.json"
                dump_path.parent.mkdir(parents=True, exist_ok=True)
                body_text = page.locator("body").inner_text(timeout=3000)[:2000]
                controls = page.locator("input, button").evaluate_all(
                    """elements => elements.map(element => ({
                        tag: element.tagName,
                        type: element.getAttribute('type'),
                        name: element.getAttribute('name'),
                        placeholder: element.getAttribute('placeholder'),
                        text: (element.innerText || element.value || '').trim(),
                        testid: element.getAttribute('data-testid'),
                    }))"""
                )
                dump_path.write_text(json.dumps({"url": page.url, "body": body_text, "controls": controls}, indent=2))
                print(f"[BROWSER] Saved OTP-page debug to: {dump_path}")
                raise RuntimeError(f"OTP input did not appear. Page: {page.url}") from error

            # Get OTP from email
            print(f"[BROWSER] OTP input detected, fetching from email...")
            self.email_reader.connect()
            otp = self.email_reader.find_otp(self.email)
            self.email_reader.disconnect()
            if not otp or not re.fullmatch(r"(?:[A-Z0-9]{3}-[A-Z0-9]{3}|\d{6})", otp, re.IGNORECASE):
                raise RuntimeError("OTP code was not found in the configured Gmail inbox")

            print(f"[BROWSER] Entering OTP: {otp}")
            otp_value = otp.replace("-", "").upper()
            if not re.fullmatch(r"[A-Z0-9]{6}", otp_value):
                raise RuntimeError(f"Invalid OTP format returned from email: {otp}")
            otp_input.click()
            otp_input.fill(otp_value)
            time.sleep(1)

            # Submit OTP
            otp_submit = page.locator('button[type="submit"], button:has-text("Confirm email"), button:has-text("Verify"), button:has-text("Continue")').first
            otp_submit.click()
            time.sleep(3)

            # After OTP, accounts.x.ai asks for first name, last name, and password.
            given_name = page.locator('input[data-testid="givenName"], input[name="givenName"], input[autocomplete="given-name"]').first
            given_name.wait_for(state="visible", timeout=30000)
            print("[BROWSER] Filling first name...")
            given_name.fill("Mirais")
            family_name = page.locator('input[data-testid="familyName"], input[name="familyName"], input[autocomplete="family-name"]').first
            family_name.fill("User")
            profile_password = page.locator('input[data-testid="password"], input[name="password"], input[type="password"]').first
            profile_password.fill(self.password)
            time.sleep(1)

            # Tick any consent/terms checkbox before submitting the sign-up.
            self._check_required_consents(page)

            page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Sign up"), button:has-text("Create account")').first.click()
            time.sleep(3)

            # Ensure the session is authenticated before the OAuth consent step.
            # Probe first; only re-login if the sign-up session did not stick.
            self._ensure_logged_in(page)

            # Navigate to device authorization only after the session is logged in.
            print(f"[BROWSER] Opening device authorization...")
            self._open_device_authorization(page, verification_url)

            # The first device page only has a positive Continue action. Do not use a
            # generic submit selector here: the confirmation page can include a submit
            # action that denies the request.
            continue_btn = page.get_by_role("button", name=re.compile(r"^Continue$", re.IGNORECASE))
            try:
                continue_btn.wait_for(state="visible", timeout=10000)
                print(f"[BROWSER] Continuing device authorization...")
                continue_btn.click(timeout=5000)
                time.sleep(2)
            except Exception as error:
                raise RuntimeError("Could not find the initial device authorization Continue button") from error

            debug_path = Path(__file__).parent.parent.parent / "data" / "xfarm-device-debug.json"
            debug_path.parent.mkdir(parents=True, exist_ok=True)
            controls = page.locator("button, input[type=submit], input[type=button], a[role=button]").evaluate_all(
                """elements => elements.map(element => ({
                    tag: element.tagName,
                    text: (element.innerText || element.value || '').trim(),
                    type: element.getAttribute('type'),
                    name: element.getAttribute('name'),
                    ariaLabel: element.getAttribute('aria-label'),
                    testid: element.getAttribute('data-testid'),
                    disabled: element.disabled,
                }))"""
            )
            debug_path.write_text(json.dumps({"url": page.url, "controls": controls}, indent=2))
            print(f"[BROWSER] Saved device controls to: {debug_path}")

            # The final confirmation action is the Allow button. Match the exact label
            # first so a partial match on "Confirm"/"Authorize" can never hit a deny
            # action. Order matters: Allow is the expected positive button.
            print(f"[BROWSER] Confirming device authorization...")
            self._click_positive_auth_button(page)
            time.sleep(5)

            print(f"[BROWSER] Authorization complete!")
            page.close()

    def _run_playwright_flow(self, verification_url: str):
        """Fallback to Playwright if Camoufox not available."""
        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=self.config["headless"])
            context = browser.new_context()
            page = context.new_page()

            print(f"[BROWSER] Opening xAI accounts signup...")
            page.goto("https://accounts.x.ai/sign-up", wait_until="networkidle")
            time.sleep(2)

            print(f"[BROWSER] Filling registration form...")
            email_input = page.locator('input[data-testid="email"], input[name="email"], input[type="email"]').first
            if not email_input.is_visible(timeout=3000):
                email_signup_selectors = [
                    'button:has-text("Sign up with email")',
                    'button:has-text("Sign up with Email")',
                    'button:has-text("Continue with email")',
                    'button:has-text("Email")',
                    'button:has(svg.lucide-mail)',
                ]
                clicked = False
                for selector in email_signup_selectors:
                    btn = page.locator(selector).first
                    try:
                        btn.wait_for(state="visible", timeout=5000)
                        btn.scroll_into_view_if_needed()
                        time.sleep(0.5)
                        btn.click(timeout=5000)
                        clicked = True
                        break
                    except Exception:
                        continue
                if not clicked:
                    raise RuntimeError("Could not click the xAI 'Sign up with email' button")
                time.sleep(2)
            email_input.wait_for(state="visible", timeout=15000)
            email_input.fill(self.email)
            self._check_required_consents(page)
            continue_btn = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Next")').first
            if continue_btn.is_visible(timeout=5000):
                continue_btn.click()
                time.sleep(2)

            print(f"[BROWSER] Fetching OTP from email...")
            self.email_reader.connect()
            otp = self.email_reader.find_otp(self.email)
            self.email_reader.disconnect()
            if not otp or not re.fullmatch(r"(?:[A-Z0-9]{3}-[A-Z0-9]{3}|\d{6})", otp, re.IGNORECASE):
                raise RuntimeError("OTP code was not found in the configured Gmail inbox")

            otp_input = page.locator('input[data-input-otp="true"], input[name="code"], input[autocomplete="one-time-code"], input[name="otp"], input[placeholder*="code" i]').first
            otp_input.wait_for(state="visible", timeout=30000)
            otp_value = otp.replace("-", "").upper()
            if not re.fullmatch(r"[A-Z0-9]{6}", otp_value):
                raise RuntimeError(f"Invalid OTP format returned from email: {otp}")
            otp_input.click()
            otp_input.fill(otp_value)
            page.locator('button[type="submit"], button:has-text("Confirm email"), button:has-text("Verify"), button:has-text("Continue")').first.click()
            time.sleep(3)

            given_name = page.locator('input[data-testid="givenName"], input[name="givenName"], input[autocomplete="given-name"]').first
            given_name.wait_for(state="visible", timeout=30000)
            given_name.fill("Mirais")
            page.locator('input[data-testid="familyName"], input[name="familyName"], input[autocomplete="family-name"]').first.fill("User")
            page.locator('input[data-testid="password"], input[name="password"], input[type="password"]').first.fill(self.password)
            self._check_required_consents(page)
            page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Sign up"), button:has-text("Create account")').first.click()
            time.sleep(3)
            print(f"[BROWSER] Verifying logged-in session...")
            self._ensure_logged_in(page)

            print(f"[BROWSER] Authorizing device...")
            self._open_device_authorization(page, verification_url)
            continue_btn = page.get_by_role("button", name=re.compile(r"^Continue$", re.IGNORECASE))
            try:
                continue_btn.wait_for(state="visible", timeout=10000)
                continue_btn.click(timeout=5000)
                time.sleep(2)
            except Exception as error:
                raise RuntimeError("Could not find the initial device authorization Continue button") from error

            # The final confirmation is the Allow button; exact-match so a partial
            # "Confirm" hit can never trigger a deny action.
            self._click_positive_auth_button(page)
            time.sleep(5)

            browser.close()

    def _poll_for_token(self, max_attempts: int = 30) -> dict:
        """Poll for OAuth token."""
        for attempt in range(max_attempts):
            result = self.poll_token()

            if "access_token" in result:
                return result

            error = result.get("error", "")
            if error == "authorization_pending":
                print(f"[POLL] Authorization pending ({attempt + 1}/{max_attempts})...")
                time.sleep(5)
            elif error == "slow_down":
                print(f"[POLL] Slow down, waiting longer...")
                time.sleep(10)
            else:
                print(f"[POLL] Error: {result}")
                return result

        return {"error": "max_attempts_exceeded"}


def main():
    parser = argparse.ArgumentParser(description="xAI Auto Register Bot")
    parser.add_argument("--output", "-o", default="xfarm_result.json", help="Output JSON file")
    parser.add_argument("--config", "-c", help="Config JSON file (from Mirais settings)")
    parser.add_argument("--email", "-e", help="Specific email to use")
    parser.add_argument("--password", "-p", help="Specific password to use")
    args = parser.parse_args()

    # Load config
    config = load_config(args.config)

    if not config["enabled"]:
        print("[ERROR] xAI farming is not enabled. Enable it in Mirais Settings → XAI IMAP Settings.")
        return 1

    if not config["gmail_username"] or not config["gmail_app_password"]:
        print("[ERROR] Gmail credentials not configured. Set GMAIL_USERNAME and GMAIL_APP_PASSWORD.")
        return 1

    print("=" * 60)
    print("xAI (Grok) Auto Register Bot")
    print("=" * 60)
    print(f"Email domain: {config['email_domain']}")
    print(f"Gmail: {config['gmail_username']}")
    print(f"Headless: {config['headless']}")
    print(f"Camoufox cache: {CAMOUFOX_CACHE}")
    print("=" * 60)

    bot = XaiFarmBot(config, email=args.email, password=args.password)
    result = bot.run()

    # Save result
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2))

    print("=" * 60)
    if result["success"]:
        print(f"[SUCCESS] Account created: {result['email']}")
        print(f"[SUCCESS] Access token: {result['access_token'][:20]}...")
    else:
        print(f"[FAILED] {result['error']}")
    print(f"[OUTPUT] Saved to: {output_path}")
    print("=" * 60)

    return 0 if result["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
