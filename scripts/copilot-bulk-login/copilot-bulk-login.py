#!/usr/bin/env python3
"""
GitHub Copilot Bulk Login Bot (Camoufox)
========================================
Signs in to GitHub Copilot with Google Workspace accounts via a browser.
Supports bulk runs: one CSV file with `email|password` per line.

Usage:
    python copilot-bulk-login.py --accounts accounts.txt --output result.json
    python copilot-bulk-login.py --accounts accounts.txt --output result.json --headless

Format accounts.txt:
    user1@domain.com|password1
    user2@domain.com|password2

Requirements:
    pip install camoufox[geoip]
    python -m camoufox fetch
"""

import argparse
import asyncio
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    from camoufox.async_api import AsyncCamoufox
except ImportError:
    print("[ERROR] Camoufox not installed. Run: pip install 'camoufox[geoip]' && python -m camoufox fetch")
    sys.exit(1)


class CopilotBulkLoginBot:
    def __init__(self, accounts: list[tuple[str, str]], headless: bool = True, copilot_home: str = None, cli_script: str = None, output_path: str = None):
        self.accounts = accounts
        self.headless = headless
        self.copilot_home = copilot_home
        self.cli_script = cli_script
        self.output_path = output_path
        self.results = []

    def log(self, msg: str):
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts}] {msg}", flush=True)

    async def _fetch_github_otp_from_gmail(self, email: str, browser, password: str = "") -> str | None:
        """Fetch the GitHub verification code from the Gmail Atom feed (Basic Auth, no JS UI)."""
        gmail_page = await browser.new_page()
        try:
            from urllib.parse import quote
            self.log(f"[{email}] Fetching GitHub verification code from Gmail feed...")
            for attempt in range(4):
                await gmail_page.goto(f"https://{quote(email)}:{quote(password)}@mail.google.com/mail/feed/atom", wait_until="load")
                await asyncio.sleep(3)
                body = await gmail_page.evaluate("document.body.innerText")
                if attempt == 0:
                    self.log(f"[{email}] Feed content (first 600): {body[:600]}")
                # Parse entries: look for the ones from GitHub
                entries = re.findall(r"<entry>(.*?)</entry>", body, re.DOTALL)
                self.log(f"[{email}] Feed entries: {len(entries)}")
                for entry in entries:
                    if "github" not in entry.lower():
                        continue
                    summary_m = re.search(r"<summary>(.*?)</summary>", entry, re.DOTALL)
                    title_m = re.search(r"<title>(.*?)</title>", entry, re.DOTALL)
                    text = (summary_m.group(1) if summary_m else "") + " " + (title_m.group(1) if title_m else "")
                    m = re.search(r"\b(\d{6,8})\b", text)
                    if m:
                        code = m.group(1)
                        self.log(f"[{email}] Found GitHub verification code: {code}")
                        return code
                self.log(f"[{email}] No GitHub code in feed (attempt {attempt + 1}/4), waiting...")
                await asyncio.sleep(8)
            self.log(f"[{email}] No verification code found in Gmail feed")
            return None
        except Exception as e:
            self.log(f"[{email}] Gmail OTP fetch error: {e}")
            return None
        finally:
            await gmail_page.close()

    async def _github_signup_via_google(self, email: str, password: str, page) -> bool:
        """Create a new GitHub account via 'Continue with Google' from the signup page.
        The Google session is already signed in, so we only need to pick the account + fill the username + Create account."""
        try:
            await page.goto("https://github.com/signup", wait_until="load")
            await asyncio.sleep(4)
            self.log(f"[{email}] Signup page: {page.url[:120]}")

            # Wait for the "Continue with Google" button to appear (the SPA renders slowly)
            google_btn = None
            for selector in ['button:has-text("Continue with Google")', 'a:has-text("Continue with Google")', 'button:has-text("Sign up with Google")', '[data-testid*="google" i]', 'button[data-provider="google"]']:
                try:
                    btn = page.locator(selector).first
                    await btn.wait_for(state="visible", timeout=15000)
                    google_btn = btn
                    self.log(f"[{email}] Found Google signup button: {selector}")
                    break
                except Exception:
                    continue
            if not google_btn:
                body_html_len = await page.evaluate("document.body ? document.body.innerHTML.length : 0")
                raw_html = await page.content()
                self.log(f"[{email}] No Google signup button. body.innerHTML.length={body_html_len}")
                self.log(f"[{email}] RAW HTML (first 800): {raw_html[:800]}")
                await page.screenshot(path=f"debug_{email.replace('@','_')}_signup.png", full_page=True)
                return False
            await google_btn.click()
            self.log(f"[{email}] Clicked signup with Google")

            # Wait for the redirect — it may go to the Google account chooser or straight back to GitHub
            for _ in range(12):
                await asyncio.sleep(2)
                url = page.url
                if "accounts.google.com" in url:
                    break
                if "github.com" in url and ("signup" in url or "join" in url):
                    break
            self.log(f"[{email}] After Google signup click: {page.url[:120]}")

            # Handle the Google account chooser / consent screen if present
            if "accounts.google.com" in page.url:
                # Pick the first account (the one signed in) or click Continue on the consent screen
                for selector in [f'div[data-identifier="{email}"]', 'div[role="link"]:has-text("@")', 'button:has-text("Continue")', '#submit_approve_access']:
                    try:
                        btn = page.locator(selector).first
                        if await btn.is_visible(timeout=3000):
                            await btn.click()
                            self.log(f"[{email}] Clicked Google account/consent: {selector}")
                            await asyncio.sleep(5)
                            break
                    except Exception:
                        continue
                # Wait to land back on GitHub
                for _ in range(12):
                    await asyncio.sleep(2)
                    if "github.com" in page.url:
                        break
                self.log(f"[{email}] Back to GitHub: {page.url[:120]}")

            # Now on the "Finish creating your account" page — fill in the username
            await asyncio.sleep(3)
            username = email.split("@")[0]
            username_input = None
            for selector in ['input[name="user_login"]', 'input#user_login', 'input[autocomplete="username"]', 'input[name*="login" i]']:
                try:
                    el = page.locator(selector).first
                    if await el.is_visible(timeout=4000):
                        username_input = el
                        break
                except Exception:
                    continue
            if username_input:
                await username_input.fill(username)
                self.log(f"[{email}] Filled username: {username}")
                await asyncio.sleep(2)
            else:
                self.log(f"[{email}] No username field. Page: {(await page.evaluate('document.body.innerText'))[:250]}")

            # Click Create account / Sign up / Continue
            for selector in ['button:has-text("Create account")', 'button:has-text("Sign up")', 'button:has-text("Continue")', 'button[type="submit"]']:
                try:
                    btn = page.locator(selector).first
                    if await btn.is_visible(timeout=5000):
                        await btn.scroll_into_view_if_needed()
                        await btn.click()
                        self.log(f"[{email}] Clicked create: {selector}")
                        await asyncio.sleep(8)
                        break
                except Exception:
                    continue
            self.log(f"[{email}] After create account: {page.url[:120]}")

            # Verify the login
            await page.goto("https://github.com", wait_until="domcontentloaded")
            await asyncio.sleep(4)
            body = await page.evaluate("document.body.innerText")
            ok = "Sign in" not in body and "Sign up" not in body[:200]
            self.log(f"[{email}] Post-signup logged-in: {ok}")
            return ok
        except Exception as e:
            self.log(f"[{email}] Signup error: {e}")
            return False

    async def _handle_device_verification(self, email: str, page, browser, password: str = "") -> bool:
        if "verified-device" not in page.url:
            return True
        self.log(f"[{email}] GitHub device verification required!")
        # Wait for the email to arrive
        await asyncio.sleep(5)
        otp = await self._fetch_github_otp_from_gmail(email, browser, password)
        if not otp:
            self.log(f"[{email}] Could not get verification code - device verification FAILED")
            return False
        # Fill the code on the verified-device page
        code_input = None
        for selector in ['input[name="otp"]', 'input#otp', 'input[type="text"]:visible', 'input[inputmode="numeric"]', 'input[autocomplete="one-time-code"]']:
            try:
                el = page.locator(selector).first
                if await el.is_visible(timeout=5000):
                    code_input = el
                    break
            except Exception:
                continue
        if not code_input:
            self.log(f"[{email}] No OTP input found on verification page")
            await page.screenshot(path=f"debug_{email.replace('@','_')}_verify.png", full_page=True)
            return False
        await code_input.fill(otp)
        self.log(f"[{email}] Entered verification code")
        await asyncio.sleep(1)
        # Submit
        for selector in ['button[type="submit"]', 'button:has-text("Verify")', 'input[type="submit"]']:
            try:
                btn = page.locator(selector).first
                if await btn.is_visible(timeout=3000):
                    await btn.click()
                    self.log(f"[{email}] Clicked verify")
                    break
            except Exception:
                continue
        await asyncio.sleep(8)
        ok = "verified-device" not in page.url
        self.log(f"[{email}] After verification URL: {page.url} — {'OK' if ok else 'STILL BLOCKED'}")
        return ok

    async def _device_flow(self, email: str, page, result: dict, browser, password: str = "") -> None:
        """Run copilot login --web-flow and open the auth URL in Camoufox (not the default browser)."""
        import subprocess, threading, re

        home = self.copilot_home
        env = {
            **os.environ,
            "COPILOT_HOME": home,
            "GH_CONFIG_DIR": str(Path(home) / "gh"),
            "BROWSER": "none",  # prevent the CLI from opening the default browser
        }

        proc = subprocess.Popen(
            ["node", self.cli_script, "login", "--device-code"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        output_lines: list[str] = []
        code_holder: list[str] = []
        done_holder: list[bool] = []

        def reader():
            for line in proc.stdout:
                output_lines.append(line)
                self.log(f"[{email}] [CLI] {line.rstrip()}")
                # Look for the device code: format "enter code XXXX-XXXX" or "one-time code: XXXX-XXXX"
                m = re.search(r"(?:one-time code|enter code)[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})", line, re.IGNORECASE)
                if m:
                    code_holder.append(m.group(1))
                    self.log(f"[{email}] Device code found: {m.group(1)}")
                # Look for success
                if "signed in successfully" in line.lower() or "authentication complete" in line.lower():
                    done_holder.append(True)

        t = threading.Thread(target=reader, daemon=True)
        t.start()

        # Wait for the device code to appear (max 30 seconds)
        code = None
        for _ in range(30):
            if code_holder:
                code = code_holder[0]
                break
            if proc.poll() is not None:
                self.log(f"[{email}] CLI exited (code={proc.returncode}) without device code")
                result["device_ok"] = proc.returncode == 0
                return
            await asyncio.sleep(1)

        if not code:
            proc.kill()
            self.log(f"[{email}] No device code from CLI, skipping")
            result["device_ok"] = False
            return

        # Open the device page in Camoufox (the session is already signed in)
        self.log(f"[{email}] Opening device page in Camoufox...")
        await page.goto("https://github.com/login/device", wait_until="domcontentloaded")
        await asyncio.sleep(3)

        # If it redirected to device verification, handle that first
        if "verified-device" in page.url:
            if not await self._handle_device_verification(email, page, browser, password):
                result["device_ok"] = False
                proc.kill()
                return
            await page.goto("https://github.com/login/device", wait_until="domcontentloaded")
            await asyncio.sleep(3)

        # Debug: print the URL and page text
        current_url = page.url
        self.log(f"[{email}] Device page URL: {current_url}")
        page_text = await page.evaluate("document.body.innerText")
        self.log(f"[{email}] Device page text (first 300): {page_text[:300]}")

        # Handle the select account page if it appears
        if "select_account" in current_url:
            for selector in [
                'input[type="submit"][value="Continue"]',
                'input[type="submit"][aria-label*="Continue"]',
                'button:has-text("Continue")',
                'input[type="submit"]',
            ]:
                try:
                    btn = page.locator(selector).first
                    if await btn.is_visible(timeout=3000):
                        await btn.click()
                        self.log(f"[{email}] Clicked Continue (select account)")
                        await asyncio.sleep(3)
                        current_url = page.url
                        self.log(f"[{email}] After select account URL: {current_url}")
                        break
                except Exception:
                    continue

        # Enter the code — the device page uses 8 separate inputs (XXXX-XXXX)
        self.log(f"[{email}] Entering device code {code}...")
        # Strip the dash from the code
        clean_code = code.replace("-", "")
        # Find all code inputs
        inputs = await page.locator('input[inputmode="text"], input[maxlength="1"], input[autocomplete="one-time-code"]').all()
        if len(inputs) >= len(clean_code):
            # Fill them one by one
            for i, char in enumerate(clean_code):
                await inputs[i].fill(char)
                await asyncio.sleep(0.1)
            self.log(f"[{email}] Entered {len(clean_code)} chars into split inputs")
        else:
            # Fallback: a single input
            code_input = None
            for selector in ['input[name="user_code"]', 'input[type="text"]:not([type="submit"])']:
                try:
                    el = page.locator(selector).first
                    if await el.is_visible(timeout=3000):
                        code_input = el
                        break
                except Exception:
                    continue
            if code_input:
                await code_input.fill(clean_code)
                self.log(f"[{email}] Entered code into single input")
            else:
                await page.screenshot(path=f"debug_{email.replace('@','_')}_device.png", full_page=True)
                self.log(f"[{email}] Could not find device code input")
                proc.kill()
                result["device_ok"] = False
                return

        # Click Continue/Verify
        for selector in ['button:has-text("Continue")', 'button:has-text("Verify")', 'button[type="submit"]']:
            try:
                btn = page.locator(selector).first
                if await btn.is_visible(timeout=3000):
                    await btn.click()
                    self.log(f"[{email}] Clicked verify")
                    await asyncio.sleep(5)
                    break
            except Exception:
                continue

        # Click Continue after entering the code
        for selector in ['button:has-text("Continue")', 'button:has-text("Verify")', 'button[type="submit"]', 'input[type="submit"]']:
            try:
                btn = page.locator(selector).first
                if await btn.is_visible(timeout=3000):
                    await btn.click()
                    self.log(f"[{email}] Clicked Continue after code entry")
                    await asyncio.sleep(5)
                    break
            except Exception:
                continue

        # Handle authorize page (Authorize GitHub Copilot CLI)
        current_url = page.url
        self.log(f"[{email}] After code URL: {current_url}")
        for selector in [
            'button:has-text("Authorize")',
            'button:has-text("Authorize github")',
            'button:has-text("Continue")',
            'button[type="submit"]',
        ]:
            try:
                btn = page.locator(selector).first
                if await btn.is_visible(timeout=5000):
                    await btn.scroll_into_view_if_needed()
                    await asyncio.sleep(0.5)
                    await btn.click()
                    self.log(f"[{email}] Clicked authorize: {selector}")
                    await asyncio.sleep(5)
                    break
            except Exception:
                continue

        # Wait for the CLI to finish
        for _ in range(30):
            if proc.poll() is not None or done_holder:
                break
            await asyncio.sleep(1)

        if proc.poll() is None:
            proc.kill()

        # Verify
        output_text = "".join(output_lines).lower()
        if proc.returncode == 0 or done_holder or "signed in successfully" in output_text:
            self.log(f"[{email}] Device flow successful!")
            result["device_ok"] = True
        else:
            self.log(f"[{email}] Device flow may have failed (exit={proc.returncode})")
            result["device_ok"] = False

    async def run(self) -> list[dict]:
        for idx, (email, password) in enumerate(self.accounts):
            self.log(f"[{idx + 1}/{len(self.accounts)}] Processing {email}...")
            try:
                result = await self._login_one(email, password)
            except Exception as e:
                result = {"email": email, "success": False, "error": f"Unhandled: {e}", "account_id": None}
                self.log(f"[{idx + 1}/{len(self.accounts)}] EXCEPTION: {e}")
            self.results.append(result)
            self.log(f"[{idx + 1}/{len(self.accounts)}] {'SUCCESS' if result['success'] else 'FAILED'}: {email}")
            # Write partial results so the server can read progress
            if self.output_path:
                try:
                    Path(self.output_path).write_text(json.dumps(self.results, indent=2), encoding="utf-8")
                except Exception:
                    pass
        return self.results

    async def _login_one(self, email: str, password: str) -> dict:
        result = {"email": email, "success": False, "error": None, "account_id": None}

        # Do not use a persistent profile — it triggers the account chooser and crashes Camoufox.
        # enable_cache=False = a clean fresh profile per account.
        camoufox_kwargs = dict(headless=self.headless, geoip=True, humanize=True, locale="en-US", enable_cache=False, timeout=300000)
        profile_dir = None

        async with AsyncCamoufox(**camoufox_kwargs) as browser:
            page = await browser.new_page()
            page.set_default_timeout(120000)

            # Fresh profile — clear storage & logout GitHub
            context = page.context
            await context.clear_cookies()
            await page.goto("https://github.com", wait_until="domcontentloaded")
            await page.evaluate("localStorage.clear(); sessionStorage.clear();")
            await asyncio.sleep(1)
            await page.goto("https://github.com/logout", wait_until="domcontentloaded")
            await asyncio.sleep(2)
            try:
                btn = page.locator('button:has-text("Sign out"), input[type="submit"]').first
                if await btn.is_visible(timeout=3000):
                    await btn.click()
                    await asyncio.sleep(3)
            except Exception:
                pass
            await context.clear_cookies()
            self.log(f"[{email}] Fresh session ready")

            try:
                # Step 1: Buka github.com/login
                self.log(f"[{email}] Opening github.com/login...")
                await page.goto("https://github.com/login", wait_until="load")
                await asyncio.sleep(5)

                # Step 2: Check whether a "Sign in with Google" button is present
                self.log(f"[{email}] Looking for Google OAuth...")
                google_btn = None
                google_selectors = [
                    'button:has-text("Sign in with Google")',
                    'a:has-text("Sign in with Google")',
                    'button:has-text("Continue with Google")',
                    'a:has-text("Continue with Google")',
                    'button[data-testid*="google"]',
                    'a[data-testid*="google"]',
                    'button:has-text("Google")',
                    'a:has-text("Google")',
                ]
                for attempt in range(3):
                    for selector in google_selectors:
                        try:
                            btn = page.locator(selector).first
                            if await btn.is_visible(timeout=2000):
                                google_btn = btn
                                self.log(f"[{email}] Found Google button: {selector}")
                                break
                        except Exception:
                            continue
                    if google_btn:
                        break
                    if attempt < 2:
                        self.log(f"[{email}] Google button not found yet, reloading (attempt {attempt + 1}/3)...")
                        await page.goto("https://github.com/login", wait_until="load")
                        await asyncio.sleep(5)

                if google_btn:
                    await google_btn.click()
                    self.log(f"[{email}] Clicked Google sign-in")
                else:
                    # Fallback: go straight to GitHub's official Google OAuth page
                    self.log(f"[{email}] No Google button, navigating to GitHub Google OAuth directly...")
                    await page.goto("https://github.com/sessions/social/google", wait_until="domcontentloaded")
                    await asyncio.sleep(3)

                # Step 3: Google login flow — wait until we are actually on accounts.google.com
                await asyncio.sleep(3)
                current_url = page.url
                self.log(f"[{email}] Current URL: {current_url[:120]}")

                if "accounts.google.com" not in current_url:
                    self.log(f"[{email}] Waiting for Google OAuth redirect...")
                    reached = False
                    for _ in range(12):
                        await asyncio.sleep(2)
                        current_url = page.url
                        if "accounts.google.com" in current_url:
                            reached = True
                            break
                    if not reached:
                        self.log(f"[{email}] Still not on Google: {current_url[:120]}")
                        raise RuntimeError("Google OAuth page never loaded after clicking Google sign-in")
                    self.log(f"[{email}] Reached Google: {current_url[:120]}")

                # Step 4: Fill the Google email — handle the account chooser first if present
                self.log(f"[{email}] Filling Google email...")
                email_input = None
                # If this is the account chooser (a list of accounts rather than an email input), pick "Use another account"
                for chooser_sel in ['div:has-text("Use another account")', 'div:has-text("Choose an account")', 'li:has-text("Use another account")']:
                    try:
                        el = page.locator(chooser_sel).last
                        if await el.is_visible(timeout=2000):
                            self.log(f"[{email}] Account chooser detected, clicking 'Use another account'...")
                            await el.click()
                            await asyncio.sleep(3)
                            break
                    except Exception:
                        continue
                for selector in ['input[type="email"]', 'input[name="identifier"]', 'input[id="identifierId"]']:
                    try:
                        el = page.locator(selector).first
                        if await el.is_visible(timeout=5000):
                            email_input = el
                            break
                    except Exception:
                        continue

                if not email_input:
                    self.log(f"[{email}] Email input not found. URL: {page.url[:150]}")
                    self.log(f"[{email}] Page text: {(await page.evaluate('document.body.innerText'))[:250]}")
                    await page.screenshot(path=f"debug_{email.replace('@','_')}_email.png", full_page=True)
                    raise RuntimeError("Could not find Google email input")

                await email_input.fill(email)
                self.log(f"[{email}] Entered email")
                # Verify the field was filled
                try:
                    val = await email_input.input_value()
                    if not val:
                        self.log(f"[{email}] Email field empty after fill, retyping...")
                        await email_input.click()
                        await email_input.type(email, delay=50)
                except Exception:
                    pass

                # Click Next — try a normal click, Enter in the field, and a JS click
                next_clicked = False
                for selector in ['#identifierNext', 'button:has-text("Next")', 'button:has-text("Continue")']:
                    try:
                        btn = page.locator(selector).first
                        if await btn.is_visible(timeout=3000):
                            await btn.click()
                            self.log(f"[{email}] Clicked Next ({selector})")
                            next_clicked = True
                            break
                    except Exception:
                        continue
                # Verify the page advanced (the password field appears); retry with Enter + JS click
                for _ in range(8):
                    await asyncio.sleep(1.5)
                    pwd_visible = False
                    for ps in ['input[type="password"]:visible', 'input[name="Passwd"]:visible']:
                        try:
                            if await page.locator(ps).first.is_visible(timeout=800):
                                pwd_visible = True
                                break
                        except Exception:
                            continue
                    if pwd_visible:
                        break
                    # Still on the email page — try pressing Enter in the email field
                    try:
                        await email_input.press("Enter")
                        self.log(f"[{email}] Pressed Enter in email field")
                    except Exception:
                        pass
                    await asyncio.sleep(2)
                    pwd_visible = False
                    for ps in ['input[type="password"]:visible', 'input[name="Passwd"]:visible']:
                        try:
                            if await page.locator(ps).first.is_visible(timeout=800):
                                pwd_visible = True
                                break
                        except Exception:
                            continue
                    if pwd_visible:
                        break
                    # Try a JS click on identifierNext
                    try:
                        await page.evaluate("document.querySelector('#identifierNext')?.click()")
                        self.log(f"[{email}] JS-clicked identifierNext")
                    except Exception:
                        pass

                # Step 5: Fill the Google password
                self.log(f"[{email}] Waiting for password field...")
                await asyncio.sleep(3)

                password_input = None
                for selector in ['input[type="password"]:visible', 'input[name="password"]:visible', 'input[name="Passwd"]:visible']:
                    try:
                        el = page.locator(selector).first
                        if await el.is_visible(timeout=10000):
                            password_input = el
                            break
                    except Exception:
                        continue

                if not password_input:
                    # Cari visible password input
                    all_passwords = await page.locator('input[type="password"]').all()
                    for pwd in all_passwords:
                        try:
                            if await pwd.is_visible():
                                password_input = pwd
                                break
                        except Exception:
                            continue

                if not password_input:
                    self.log(f"[{email}] Password field not found. Current URL: {page.url[:200]}")
                    body_text = (await page.evaluate("document.body.innerText"))[:200]
                    self.log(f"[{email}] Page text: {body_text}")
                    await page.screenshot(path=f"debug_{email.replace('@','_')}_password.png", full_page=True)
                    raise RuntimeError("Could not find Google password input")

                await password_input.fill(password)
                self.log(f"[{email}] Entered password")

                # Click Next/Sign in
                for selector in ['button:has-text("Next")', 'button:has-text("Sign in")', '#passwordNext']:
                    try:
                        btn = page.locator(selector).first
                        if await btn.is_visible(timeout=3000):
                            await btn.click()
                            self.log(f"[{email}] Clicked sign-in")
                            break
                    except Exception:
                        continue

                # Step 6: Wait for the redirect to GitHub
                self.log(f"[{email}] Waiting for redirect to GitHub...")
                await asyncio.sleep(10)

                # Step 7: Handle 2FA/MFA if requested
                current_url = page.url
                self.log(f"[{email}] After login URL: {current_url}")

                if "accounts.google.com" in current_url:
                    # Handle Workspace Terms of Service speed bump
                    if "speedbump/workspacetermsofservice" in current_url:
                        self.log(f"[{email}] Workspace Terms of Service page detected! Accepting...")
                        # Scroll to the bottom until the understand button appears
                        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                        await asyncio.sleep(1)
                        # Look for the Accept/Continue/I understand button
                        for selector in [
                            'button:has-text("I understand")',
                            'button:has-text("I agree")',
                            'button:has-text("Accept")',
                            'button:has-text("Continue")',
                            'button[type="submit"]',
                            'form button',
                            '[role="button"]:has-text("I understand")',
                        ]:
                            try:
                                btn = page.locator(selector).first
                                if await btn.is_visible(timeout=3000):
                                    await btn.scroll_into_view_if_needed()
                                    await asyncio.sleep(0.5)
                                    await btn.click()
                                    self.log(f"[{email}] Clicked accept: {selector}")
                                    await asyncio.sleep(8)
                                    break
                            except Exception:
                                continue
                        current_url = page.url
                        self.log(f"[{email}] After ToS URL: {current_url}")

                    # Handle OAuth consent page (Allow/Continue)
                    if "signin/oauth" in current_url or "oauth/consent" in current_url:
                        self.log(f"[{email}] OAuth consent page detected! Allowing...")
                        # Take a screenshot first for visibility
                        await page.screenshot(path=f"debug_{email.replace('@','_')}_oauth.png", full_page=True)
                        self.log(f"[{email}] OAuth screenshot saved")
                        # Try clicking the Continue/Allow button in several ways
                        for selector in [
                            'button:has-text("Continue")',
                            'button:has-text("Allow")',
                            'button:has-text("Accept")',
                            '#submit_approve_access',
                            'div[role="button"]:has-text("Continue")',
                            'div[role="button"]:has-text("Allow")',
                            '[data-testid="consent-accept-button"]',
                            'form button[type="submit"]',
                            'button.VfPpkd-LgbsSe',
                            'span:has-text("Continue")',
                            'span:has-text("Allow")',
                        ]:
                            try:
                                btn = page.locator(selector).first
                                if await btn.is_visible(timeout=3000):
                                    self.log(f"[{email}] Found button: {selector}")
                                    await btn.scroll_into_view_if_needed()
                                    await asyncio.sleep(0.5)
                                    await btn.click()
                                    self.log(f"[{email}] Clicked allow: {selector}")
                                    await asyncio.sleep(8)
                                    break
                            except Exception:
                                continue
                        current_url = page.url
                        self.log(f"[{email}] After OAuth consent URL: {current_url[:120]}")
                        # Wait for the redirect to github.com (not /login) — poll every 2 seconds
                        for _ in range(12):
                            await asyncio.sleep(2)
                            current_url = page.url
                            self.log(f"[{email}] Post-consent URL: {current_url[:120]}")
                            if "github.com" in current_url and "accounts.google.com" not in current_url and "github.com/login" not in current_url:
                                break

                    # Check whether a 2FA prompt appeared
                    if "signin/challenge" in current_url or "challenge" in current_url:
                        self.log(f"[{email}] 2FA challenge detected! Waiting for manual intervention...")
                        await asyncio.sleep(30)
                        current_url = page.url
                        self.log(f"[{email}] After 2FA URL: {current_url}")

                if "accounts.google.com" in current_url:
                    raise RuntimeError("Still on Google accounts page - login may have failed or 2FA required")

                # Handle GitHub device verification (email OTP) if it appears
                if "verified-device" in current_url:
                    if not await self._handle_device_verification(email, page, browser, password):
                        raise RuntimeError("GitHub device verification failed - could not verify via Gmail OTP")
                    current_url = page.url

                # Step 8: Verify the GitHub login succeeded — check the avatar/logged-in state, not just the URL
                self.log(f"[{email}] Verifying GitHub login...")
                if "github.com" not in current_url or "github.com/login" in current_url:
                    await page.goto("https://github.com", wait_until="domcontentloaded")
                    await asyncio.sleep(4)

                current_url = page.url
                self.log(f"[{email}] Final URL: {current_url[:120]}")
                # Log the page content to debug the signup/login state
                page_text = (await page.evaluate("document.body.innerText"))[:400]
                self.log(f"[{email}] Page content: {page_text}")

                # Handle GitHub signup page (new account) — auto-create account
                if "signup" in current_url:
                    self.log(f"[{email}] GitHub signup page detected! Creating account...")
                    # Derive the username from the email (the part before @)
                    username = email.split("@")[0]
                    # Look for the username input
                    username_input = None
                    for selector in ['input[name="user_login"]', 'input#user_login', 'input[autocomplete="username"]', 'input:not([type="hidden"])']:
                        try:
                            el = page.locator(selector).first
                            if await el.is_visible(timeout=3000):
                                username_input = el
                                break
                        except Exception:
                            continue
                    if username_input:
                        await username_input.fill(username)
                        self.log(f"[{email}] Filled username: {username}")
                        await asyncio.sleep(1)
                    # Klik "Create account"
                    for selector in [
                        'button:has-text("Create account")',
                        'button[type="submit"]',
                        '.signup-form-fields__button',
                        'button.Button--primary',
                    ]:
                        try:
                            btn = page.locator(selector).first
                            if await btn.is_visible(timeout=5000):
                                await btn.scroll_into_view_if_needed()
                                await asyncio.sleep(0.5)
                                await btn.click()
                                self.log(f"[{email}] Clicked Create account")
                                await asyncio.sleep(10)
                                break
                        except Exception:
                            continue
                    current_url = page.url
                    self.log(f"[{email}] After signup URL: {current_url}")

                # Check whether we are really signed in — strict detection: a logged-in homepage has
                # links to the dashboard/notifications, not a "Sign in" button.
                logged_in = False
                for probe in ['a[href="/notifications"]', 'a[href="/dashboard"]', 'summary[aria-label*="profile" i]', 'button[aria-label*="Open user navigation" i]', '[data-test-selector="nav-search-input"]']:
                    try:
                        if await page.locator(probe).count() > 0:
                            logged_in = True
                            break
                    except Exception:
                        continue
                if not logged_in:
                    # Confirm via the body text: the presence of "Sign in"/"Sign up" means we are NOT signed in
                    body = await page.evaluate("document.body.innerText")
                    if "Sign in" in body or "Username or email" in body:
                        logged_in = False
                self.log(f"[{email}] Logged-in check: {logged_in}")

                # If NOT signed in → the Google account has no GitHub account yet. Create one via the signup flow.
                if not logged_in:
                    self.log(f"[{email}] Not logged in — trying GitHub signup via Google...")
                    logged_in = await self._github_signup_via_google(email, password, page)
                    if not logged_in:
                        raise RuntimeError("Could not create or sign into GitHub account")
                    self.log(f"[{email}] Signed up & logged in!")

                self.log(f"[{email}] GitHub login successful!")

                # Step 9: Enable GitHub Copilot Free
                self.log(f"[{email}] Enabling GitHub Copilot Free...")
                await page.goto("https://github.com/settings/copilot/features", wait_until="domcontentloaded")
                await asyncio.sleep(5)
                # Click "Start using Copilot Free"
                for selector in [
                    'a:has-text("Start using Copilot Free")',
                    'a[href*="/github-copilot/signup"]',
                    'a[aria-label*="copilot signup"]',
                    'a.Button--secondary:has-text("Copilot")',
                ]:
                    try:
                        btn = page.locator(selector).first
                        if await btn.is_visible(timeout=5000):
                            await btn.scroll_into_view_if_needed()
                            await asyncio.sleep(0.5)
                            await btn.click()
                            self.log(f"[{email}] Clicked Start using Copilot Free")
                            await asyncio.sleep(8)
                            break
                    except Exception:
                        continue
                current_url = page.url
                self.log(f"[{email}] After Copilot enable URL: {current_url}")

                # Step 10: Open the Copilot settings page to verify
                self.log(f"[{email}] Verifying Copilot access...")
                await page.goto("https://github.com/settings/copilot", wait_until="domcontentloaded")
                await asyncio.sleep(5)

                # Check whether Copilot is active
                copilot_content = await page.content()
                if "GitHub Copilot" in copilot_content:
                    self.log(f"[{email}] Copilot page loaded")
                else:
                    self.log(f"[{email}] Copilot page may not be accessible")

                # Screenshot for verification
                await page.screenshot(path=f"copilot_{email.replace('@','_')}_result.png", full_page=True)
                self.log(f"[{email}] Screenshot saved")

                # Step 11: Device flow — run copilot login --web-flow and enter the code in the browser
                if self.cli_script and self.copilot_home:
                    self.log(f"[{email}] Starting Copilot CLI device flow...")
                    await self._device_flow(email, page, result, browser, password)

                result["success"] = result["success"] or result.get("device_ok", False)

            except Exception as e:
                result["error"] = str(e)
                self.log(f"[{email}] ERROR: {e}")
                try:
                    await page.screenshot(path=f"debug_{email.replace('@','_')}_error.png", full_page=True)
                except Exception:
                    pass

        return result


async def main():
    parser = argparse.ArgumentParser(description="GitHub Copilot Bulk Login Bot (Camoufox)")
    parser.add_argument("--accounts", "-a", required=True, help="File with email|password per line")
    parser.add_argument("--output", "-o", default="copilot_bulk_result.json", help="Output JSON file")
    parser.add_argument("--headless", action="store_true", default=True, help="Run headless (default: True)")
    parser.add_argument("--no-headless", dest="headless", action="store_false", help="Run with visible browser")
    parser.add_argument("--copilot-home", default=None, help="COPILOT_HOME directory for CLI auth")
    parser.add_argument("--cli-script", default=None, help="Path to copilot npm-loader.js")
    args = parser.parse_args()

    # Read accounts
    accounts_path = Path(args.accounts)
    if not accounts_path.exists():
        print(f"[ERROR] Accounts file not found: {args.accounts}")
        sys.exit(1)

    accounts = []
    with open(accounts_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("|", 1)
            if len(parts) == 2:
                accounts.append((parts[0].strip(), parts[1].strip()))

    if not accounts:
        print("[ERROR] No valid accounts found in file")
        sys.exit(1)

    print("=" * 60)
    print("GitHub Copilot Bulk Login Bot (Camoufox)")
    print("=" * 60)
    print(f"Accounts: {len(accounts)}")
    print(f"Headless: {args.headless}")
    print("=" * 60)

    bot = CopilotBulkLoginBot(accounts, headless=args.headless, copilot_home=args.copilot_home, cli_script=args.cli_script, output_path=args.output)
    results = await bot.run()

    # Save results
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(results, indent=2))

    # Summary
    success_count = sum(1 for r in results if r["success"])
    print("=" * 60)
    print(f"Results: {success_count}/{len(results)} successful")
    for r in results:
        status = "OK" if r["success"] else "FAIL"
        print(f"  {status} {r['email']}: {r.get('error', 'OK')}")
    print(f"Output: {output_path}")
    print("=" * 60)

    return 0 if success_count == len(results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))