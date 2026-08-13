#!/usr/bin/env python3
"""
xAI API Key Farmer (Camoufox)
=============================
Standalone bot to create API keys from console.x.ai using existing account credentials.
Uses Camoufox (stealth Firefox) for better Cloudflare bypass.

Usage:
    python apikey-farmer-camoufox.py --email "user@example.com" --password "password123"
    python apikey-farmer-camoufox.py --email "user@example.com" --password "password123" --output result.json

Requirements:
    pip install camoufox[geoip]
    python -m camoufox fetch
"""

import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path
from datetime import datetime

try:
    from camoufox.async_api import AsyncCamoufox
except ImportError:
    print("[ERROR] Camoufox not installed. Run: pip install 'camoufox[geoip]' && python -m camoufox fetch")
    sys.exit(1)


class XaiApiKeyFarmerCamoufox:
    def __init__(self, email: str, password: str, headless: bool = True):
        self.email = email
        self.password = password
        self.headless = headless
        self.api_key = None
        self.error = None

    def log(self, msg: str):
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts}] {msg}", flush=True)

    async def run(self) -> dict:
        """Main flow: login → navigate to API keys → create key → extract."""
        result = {
            "success": False,
            "email": self.email,
            "api_key": None,
            "key_name": None,
            "error": None,
        }

        launch_kwargs = {
            "headless": self.headless,
            "geoip": True,
            "humanize": True,
            "locale": "en-US",
        }

        async with AsyncCamoufox(**launch_kwargs) as browser:
            page = await browser.new_page()
            page.set_default_timeout(120000)

            try:
                # Step 1: Open console.x.ai
                self.log("[STEP 1] Opening console.x.ai...")
                await page.goto("https://console.x.ai/", wait_until="domcontentloaded")
                self.log("[INFO] Page loaded, waiting...")
                await asyncio.sleep(5)

                # Check for Cloudflare
                if await page.locator('text=/challenge|cloudflare|verify you are human/i').count() > 0:
                    self.log("[WARN] Cloudflare detected, waiting...")
                    await asyncio.sleep(10)

                self.log(f"[INFO] Current URL: {page.url}")

                # Step 2: Check if already logged in or need login
                # Check for actual logged-in state, not just URL
                is_logged_in = False
                if "/dashboard" in page.url:
                    is_logged_in = True
                elif "/home" in page.url:
                    # Verify by checking for user menu or logout button
                    if await page.locator('button:has-text("Logout"), button:has-text("Sign out"), [data-testid*="user"]').count() > 0:
                        is_logged_in = True
                    else:
                        # Might be on home but not logged in
                        self.log("[INFO] On /home but not sure if logged in, checking...")
                        await asyncio.sleep(2)

                if is_logged_in:
                    self.log("[INFO] Already logged in")
                else:
                    self.log("[INFO] Not logged in, starting login flow...")
                    await self._do_login(page)

                    # After login, verify we're actually logged in
                    await asyncio.sleep(3)
                    if "/login" in page.url or "/signin" in page.url:
                        raise RuntimeError("Login failed - still on login page")

                # Step 3: Navigate to API keys
                self.log("[STEP 3] Navigating to API keys...")
                await page.goto("https://console.x.ai/api-keys", wait_until="domcontentloaded")
                await asyncio.sleep(5)
                self.log(f"[INFO] Current URL: {page.url}")

                # Verify we're not redirected to login
                if "/login" in page.url or "/signin" in page.url:
                    self.log("[ERROR] Redirected to login after navigation!")
                    self.log("[INFO] Trying to login again...")
                    await self._do_login(page)
                    await asyncio.sleep(3)
                    await page.goto("https://console.x.ai/api-keys", wait_until="domcontentloaded")
                    await asyncio.sleep(5)
                    self.log(f"[INFO] After re-login URL: {page.url}")

                # Step 4: Create API key
                api_key = await self._create_api_key(page)
                if api_key:
                    result["success"] = True
                    result["api_key"] = api_key
                    result["key_name"] = f"mirais-farm-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
                    self.log(f"[SUCCESS] API key extracted: {api_key[:25]}...")
                else:
                    raise RuntimeError("Failed to extract API key")

            except Exception as e:
                self.error = str(e)
                result["error"] = self.error
                self.log(f"[ERROR] {self.error}")
                try:
                    await page.screenshot(path="debug_error.png", full_page=True)
                    self.log("[DEBUG] Screenshot saved to debug_error.png")
                except Exception:
                    pass

        return result

    async def _do_login(self, page):
        """Handle login flow - supports both direct xAI and Google OAuth."""
        self.log("[LOGIN] Starting login flow...")

        current_url = page.url
        self.log(f"[LOGIN] Current URL: {current_url}")

        # If on home page, look for sign-in button
        if "/home" in current_url or current_url == "https://console.x.ai/":
            self.log("[LOGIN] On home page, looking for sign-in...")
            signin_selectors = [
                'button:has-text("Sign in")',
                'button:has-text("Log in")',
                'a:has-text("Sign in")',
                'a:has-text("Log in")',
                'button:has-text("Get started")',
                'text=/sign in/i',
                'text=/log in/i',
            ]

            clicked = False
            for selector in signin_selectors:
                try:
                    btn = page.locator(selector).first
                    if await btn.is_visible(timeout=3000):
                        await btn.click()
                        self.log(f"[LOGIN] Clicked: {selector}")
                        clicked = True
                        await asyncio.sleep(5)
                        break
                except Exception:
                    continue

            if not clicked:
                self.log("[WARN] No sign-in button found, trying direct navigation...")
                await page.goto("https://console.x.ai/login", wait_until="domcontentloaded")
                await asyncio.sleep(3)

        # Check if redirected to Google OAuth
        await asyncio.sleep(3)
        current_url = page.url
        self.log(f"[LOGIN] After sign-in URL: {current_url}")

        if "accounts.google.com" in current_url:
            self.log("[LOGIN] Detected Google OAuth flow")
            await self._do_google_login(page)
        else:
            self.log("[LOGIN] Direct xAI login flow")
            await self._do_xai_direct_login(page)

        # Wait for login to complete
        self.log("[LOGIN] Waiting for login to complete...")
        await asyncio.sleep(10)

        # Check result
        final_url = page.url
        self.log(f"[LOGIN] After login URL: {final_url}")

        if "/login" in final_url or "/signin" in final_url or "accounts.google.com" in final_url:
            raise RuntimeError("Login failed - still on login page")

        self.log("[LOGIN] Login successful!")

    async def _do_google_login(self, page):
        """Handle Google OAuth login."""
        self.log("[GOOGLE] Starting Google OAuth login...")

        # Google email input
        email_selectors = [
            'input[type="email"]',
            'input[name="identifier"]',
            'input[id="identifierId"]',
        ]

        email_input = None
        for selector in email_selectors:
            try:
                el = page.locator(selector).first
                if await el.is_visible(timeout=5000):
                    email_input = el
                    self.log(f"[GOOGLE] Found email input: {selector}")
                    break
            except Exception:
                continue

        if not email_input:
            raise RuntimeError("Could not find Google email input")

        await email_input.fill(self.email)
        self.log(f"[GOOGLE] Entered email: {self.email}")

        # Click Next
        next_selectors = [
            'button:has-text("Next")',
            'button:has-text("Continue")',
            '#identifierNext',
        ]

        for selector in next_selectors:
            try:
                btn = page.locator(selector).first
                if await btn.is_visible(timeout=3000):
                    await btn.click()
                    self.log(f"[GOOGLE] Clicked next: {selector}")
                    break
            except Exception:
                continue

        # Wait for password page
        self.log("[GOOGLE] Waiting for password page...")
        await asyncio.sleep(5)

        # Google password input - must be visible
        password_selectors = [
            'input[type="password"]:visible',
            'input[name="password"]:visible',
            'input[name="Passwd"]:visible',
        ]

        password_input = None
        for selector in password_selectors:
            try:
                el = page.locator(selector).first
                if await el.is_visible(timeout=10000):
                    password_input = el
                    self.log(f"[GOOGLE] Found password input: {selector}")
                    break
            except Exception:
                continue

        if not password_input:
            # Try to find any visible password input
            all_passwords = await page.locator('input[type="password"]').all()
            for pwd in all_passwords:
                try:
                    if await pwd.is_visible():
                        password_input = pwd
                        self.log("[GOOGLE] Found visible password input")
                        break
                except Exception:
                    continue

        if not password_input:
            await page.screenshot(path="debug_google_password.png", full_page=True)
            raise RuntimeError("Could not find Google password input")

        await password_input.fill(self.password)
        self.log("[GOOGLE] Entered password")

        # Click Next/Sign in
        signin_selectors = [
            'button:has-text("Next")',
            'button:has-text("Sign in")',
            '#passwordNext',
        ]

        for selector in signin_selectors:
            try:
                btn = page.locator(selector).first
                if await btn.is_visible(timeout=3000):
                    await btn.click()
                    self.log(f"[GOOGLE] Clicked sign-in: {selector}")
                    break
            except Exception:
                continue

        # Wait for redirect back to xAI
        self.log("[GOOGLE] Waiting for redirect to xAI...")
        await asyncio.sleep(10)

    async def _do_xai_direct_login(self, page):
        """Handle direct xAI login (email + password on same or separate pages)."""
        self.log("[XAI] Starting direct xAI login...")

        # Wait for email input
        email_selectors = [
            'input[type="email"]',
            'input[name="email"]',
            'input[placeholder*="email" i]',
        ]

        email_input = None
        for selector in email_selectors:
            try:
                el = page.locator(selector).first
                if await el.is_visible(timeout=5000):
                    email_input = el
                    self.log(f"[XAI] Found email input: {selector}")
                    break
            except Exception:
                continue

        if not email_input:
            raise RuntimeError("Could not find xAI email input")

        await email_input.fill(self.email)
        self.log(f"[XAI] Entered email: {self.email}")

        # Click Continue/Next button
        self.log("[XAI] Looking for Continue/Next button...")
        continue_selectors = [
            'button:has-text("Continue")',
            'button:has-text("Next")',
            'button:has-text("Sign in")',
            'button[type="submit"]',
        ]

        clicked = False
        for selector in continue_selectors:
            try:
                btn = page.locator(selector).first
                if await btn.is_visible(timeout=3000):
                    await btn.click()
                    self.log(f"[XAI] Clicked: {selector}")
                    clicked = True
                    break
            except Exception:
                continue

        if not clicked:
            self.log("[XAI] No continue button found, trying Enter key...")
            await email_input.press("Enter")

        # Wait for password field to appear (single-page transition)
        self.log("[XAI] Waiting for password field to appear...")
        await asyncio.sleep(5)

        # Try to find password field - it may appear dynamically
        password_input = None
        for attempt in range(10):
            self.log(f"[XAI] Looking for password field... (attempt {attempt + 1}/10)")

            # Check for visible password input
            password_selectors = [
                'input[type="password"]:visible',
                'input[name="password"]:visible',
                'input[placeholder*="password" i]:visible',
                'input[autocomplete="current-password"]:visible',
            ]

            for selector in password_selectors:
                try:
                    el = page.locator(selector).first
                    if await el.is_visible(timeout=2000):
                        password_input = el
                        self.log(f"[XAI] Found password input: {selector}")
                        break
                except Exception:
                    continue

            if password_input:
                break

            # Check if URL changed (may indicate Google OAuth)
            current_url = page.url
            if "accounts.google.com" in current_url:
                self.log("[XAI] Redirected to Google OAuth, switching flow...")
                await self._do_google_login(page)
                return

            await asyncio.sleep(2)

        if not password_input:
            # Take screenshot for debugging
            await page.screenshot(path="debug_after_continue.png", full_page=True)
            self.log("[DEBUG] Screenshot saved to debug_after_continue.png")
            raise RuntimeError("Could not find xAI password input after 10 attempts")

        await password_input.fill(self.password)
        self.log("[XAI] Entered password")

        # Submit login
        self.log("[XAI] Submitting login...")
        submit_selectors = [
            'button[type="submit"]:visible',
            'button:has-text("Sign in"):visible',
            'button:has-text("Log in"):visible',
            'button:has-text("Continue"):visible',
        ]

        for selector in submit_selectors:
            try:
                btn = page.locator(selector).first
                if await btn.is_visible(timeout=3000):
                    await btn.click()
                    self.log(f"[XAI] Clicked submit: {selector}")
                    break
            except Exception:
                continue

    async def _create_api_key(self, page) -> str | None:
        """Create and extract API key."""
        self.log("[STEP 4] Looking for 'Create API Key' button...")

        create_selectors = [
            'button:has-text("Create API Key")',
            'button:has-text("Create new key")',
            'button:has-text("New API Key")',
            'button:has-text("Add API Key")',
            'button:has-text("Generate")',
            'button[data-testid*="create"]',
            'button[data-testid*="new"]',
        ]

        create_btn = None
        for selector in create_selectors:
            try:
                btn = page.locator(selector).first
                if await btn.is_visible(timeout=3000):
                    create_btn = btn
                    self.log(f"[INFO] Found create button: {selector}")
                    break
            except Exception:
                continue

        if not create_btn:
            await page.screenshot(path="debug_apikeys.png", full_page=True)
            raise RuntimeError("Could not find 'Create API Key' button. Screenshot saved.")

        await create_btn.click()
        self.log("[INFO] Clicked create button")
        await asyncio.sleep(3)

        # Fill key name if required
        key_name = f"mirais-farm-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        name_input = page.locator('input[name="name"], input[placeholder*="name" i], input[placeholder*="label" i]').first
        if await name_input.is_visible(timeout=3000):
            await name_input.fill(key_name)
            self.log(f"[INFO] Set key name: {key_name}")

        # Submit creation
        submit_selectors = [
            'button[type="submit"]',
            'button:has-text("Create")',
            'button:has-text("Generate")',
            'button:has-text("Confirm")',
            'button:has-text("Save")',
        ]

        for selector in submit_selectors:
            try:
                btn = page.locator(selector).first
                if await btn.is_visible(timeout=3000):
                    await btn.click()
                    self.log(f"[INFO] Clicked submit: {selector}")
                    break
            except Exception:
                continue

        self.log("[INFO] Waiting for key generation...")
        await asyncio.sleep(5)

        # Extract API key
        self.log("[STEP 6] Extracting API key...")

        key_selectors = [
            'code:has-text("xai-")',
            'pre:has-text("xai-")',
            'input[value*="xai-"]',
            'div:has-text("xai-")',
            'span:has-text("xai-")',
            '[data-testid*="key"]',
            '[data-testid*="secret"]',
        ]

        for selector in key_selectors:
            try:
                el = page.locator(selector).first
                if await el.is_visible(timeout=5000):
                    text = await el.text_content() or await el.get_attribute("value") or ""
                    match = re.search(r"xai-[a-zA-Z0-9]{32,}", text)
                    if match:
                        return match.group(0)
            except Exception:
                continue

        # Try to find in page content
        content = await page.content()
        match = re.search(r"xai-[a-zA-Z0-9]{32,}", content)
        if match:
            return match.group(0)

        await page.screenshot(path="debug_key_extract.png", full_page=True)
        return None


async def main():
    parser = argparse.ArgumentParser(description="xAI API Key Farmer (Camoufox)")
    parser.add_argument("--email", "-e", required=True, help="xAI account email")
    parser.add_argument("--password", "-p", required=True, help="xAI account password")
    parser.add_argument("--output", "-o", help="Output JSON file")
    parser.add_argument("--headless", action="store_true", default=True, help="Run headless (default: True)")
    parser.add_argument("--no-headless", dest="headless", action="store_false", help="Run with visible browser")
    args = parser.parse_args()

    print("=" * 60)
    print("xAI API Key Farmer (Camoufox)")
    print("=" * 60)
    print(f"Email: {args.email}")
    print(f"Headless: {args.headless}")
    print("=" * 60)

    farmer = XaiApiKeyFarmerCamoufox(args.email, args.password, headless=args.headless)
    result = await farmer.run()

    if args.output:
        output_path = Path(args.output)
        output_path.write_text(json.dumps(result, indent=2))
        print(f"\n[OUTPUT] Saved to: {output_path}")

    print("=" * 60)
    if result["success"]:
        print(f"[SUCCESS] API Key: {result['api_key']}")
    else:
        print(f"[FAILED] {result['error']}")
    print("=" * 60)

    return 0 if result["success"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
