#!/usr/bin/env python3
"""
xAI API Key Farmer
==================
Standalone bot to create API keys from console.x.ai using existing account credentials.

Usage:
    python apikey-farmer.py --email "user@example.com" --password "password123"
    python apikey-farmer.py --email "user@example.com" --password "password123" --output result.json

Requirements:
    pip install playwright
    playwright install chromium
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path
from datetime import datetime

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
except ImportError:
    print("[ERROR] Playwright not installed. Run: pip install playwright && playwright install chromium")
    sys.exit(1)


class XaiApiKeyFarmer:
    def __init__(self, email: str, password: str, headless: bool = True):
        self.email = email
        self.password = password
        self.headless = headless
        self.api_key = None
        self.error = None

    def log(self, msg: str):
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts}] {msg}")

    def run(self) -> dict:
        """Main flow: login → navigate to API keys → create key → extract."""
        result = {
            "success": False,
            "email": self.email,
            "api_key": None,
            "key_name": None,
            "error": None,
        }

        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                headless=self.headless,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--disable-web-security",
                    "--disable-features=IsolateOrigins,site-per-process",
                ]
            )

            context = browser.new_context(
                viewport={"width": 1280, "height": 800},
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                locale="en-US",
                timezone_id="America/New_York",
            )

            # Stealth: remove webdriver flag
            context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
                Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
                window.chrome = {runtime: {}};
            """)

            page = context.new_page()

            try:
                # Step 1: Login to console.x.ai
                self.log("[STEP 1] Opening console.x.ai...")
                
                # Try with domcontentloaded first (faster), then wait for networkidle manually
                page.goto("https://console.x.ai/", wait_until="domcontentloaded", timeout=120000)
                self.log("[INFO] Page loaded, waiting for network idle...")
                
                # Wait for Cloudflare challenge if present
                time.sleep(5)
                
                # Check for Cloudflare
                if page.locator('text=/challenge|cloudflare|verify you are human/i').first.is_visible(timeout=5000):
                    self.log("[WARN] Cloudflare challenge detected, waiting...")
                    time.sleep(10)
                
                # Wait for network to settle
                try:
                    page.wait_for_load_state("networkidle", timeout=30000)
                except Exception:
                    self.log("[WARN] Network idle timeout, continuing anyway...")
                
                time.sleep(2)
                self.log(f"[INFO] Current URL: {page.url}")

                # Check if already logged in
                if page.url.startswith("https://console.x.ai/dashboard"):
                    self.log("[INFO] Already logged in")
                else:
                    # Look for login/signin button or form
                    self.log("[STEP 2] Looking for login form...")

                    # Try to find email input directly
                    email_input = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first
                    if email_input.is_visible(timeout=5000):
                        self.log("[INFO] Found email input, filling credentials...")
                        email_input.fill(self.email)

                        # Find password input
                        password_input = page.locator('input[type="password"], input[name="password"]').first
                        password_input.wait_for(state="visible", timeout=5000)
                        password_input.fill(self.password)

                        # Submit
                        submit_btn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Continue")').first
                        submit_btn.click(timeout=5000)
                        self.log("[INFO] Submitted login form")
                    else:
                        # Try clicking "Sign in" or "Log in" button first
                        self.log("[INFO] Looking for sign-in button...")
                        signin_selectors = [
                            'button:has-text("Sign in")',
                            'button:has-text("Log in")',
                            'a:has-text("Sign in")',
                            'a:has-text("Log in")',
                            'button:has-text("Get started")',
                        ]
                        clicked = False
                        for selector in signin_selectors:
                            btn = page.locator(selector).first
                            try:
                                btn.wait_for(state="visible", timeout=3000)
                                btn.click(timeout=5000)
                                clicked = True
                                self.log(f"[INFO] Clicked: {selector}")
                                time.sleep(2)
                                break
                            except Exception:
                                continue

                        if not clicked:
                            raise RuntimeError("Could not find sign-in button")

                        # Now fill credentials
                        email_input = page.locator('input[type="email"], input[name="email"]').first
                        email_input.wait_for(state="visible", timeout=10000)
                        email_input.fill(self.email)

                        password_input = page.locator('input[type="password"], input[name="password"]').first
                        password_input.fill(self.password)

                        submit_btn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Continue")').first
                        submit_btn.click(timeout=5000)

                    # Wait for login to complete
                    self.log("[INFO] Waiting for login to complete...")
                    time.sleep(5)

                    # Check for 2FA or CAPTCHA
                    if page.locator('text=/two-factor|2fa|verification/i').first.is_visible(timeout=3000):
                        raise RuntimeError("2FA detected - not supported in automated flow")

                    if page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]').first.is_visible(timeout=3000):
                        raise RuntimeError("CAPTCHA detected - manual intervention required")

                # Step 3: Navigate to API keys
                self.log("[STEP 3] Navigating to API keys...")
                page.goto("https://console.x.ai/api-keys", wait_until="domcontentloaded", timeout=120000)
                time.sleep(3)
                
                # Wait for page to fully load
                try:
                    page.wait_for_load_state("networkidle", timeout=30000)
                except Exception:
                    self.log("[WARN] Network idle timeout, continuing...")
                
                time.sleep(2)

                # Step 4: Create new API key
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
                        btn.wait_for(state="visible", timeout=3000)
                        create_btn = btn
                        self.log(f"[INFO] Found create button: {selector}")
                        break
                    except Exception:
                        continue

                if not create_btn:
                    # Take screenshot for debugging
                    page.screenshot(path="debug_apikeys.png")
                    raise RuntimeError("Could not find 'Create API Key' button. Screenshot saved to debug_apikeys.png")

                create_btn.click(timeout=5000)
                time.sleep(2)

                # Step 5: Fill API key name (if required)
                self.log("[STEP 5] Configuring API key...")

                key_name = f"mirais-farm-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
                name_input = page.locator('input[name="name"], input[placeholder*="name" i], input[placeholder*="label" i]').first
                if name_input.is_visible(timeout=3000):
                    name_input.fill(key_name)
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
                        btn.wait_for(state="visible", timeout=3000)
                        btn.click(timeout=5000)
                        self.log(f"[INFO] Clicked submit: {selector}")
                        break
                    except Exception:
                        continue

                time.sleep(3)

                # Step 6: Extract the API key
                self.log("[STEP 6] Extracting API key...")

                # The key might be shown in a modal, a code block, or an input field
                key_selectors = [
                    'code:has-text("xai-")',
                    'pre:has-text("xai-")',
                    'input[value*="xai-"]',
                    'div:has-text("xai-")',
                    'span:has-text("xai-")',
                    '[data-testid*="key"]',
                    '[data-testid*="secret"]',
                ]

                api_key = None
                for selector in key_selectors:
                    try:
                        el = page.locator(selector).first
                        el.wait_for(state="visible", timeout=5000)
                        text = el.text_content() or el.get_attribute("value") or ""
                        match = re.search(r"xai-[a-zA-Z0-9]{32,}", text)
                        if match:
                            api_key = match.group(0)
                            self.log(f"[SUCCESS] Found API key: {api_key[:20]}...")
                            break
                    except Exception:
                        continue

                if not api_key:
                    # Try to find in page content
                    content = page.content()
                    match = re.search(r"xai-[a-zA-Z0-9]{32,}", content)
                    if match:
                        api_key = match.group(0)
                        self.log(f"[SUCCESS] Found API key in page content: {api_key[:20]}...")

                if not api_key:
                    page.screenshot(path="debug_key_extract.png")
                    raise RuntimeError("Could not extract API key. Screenshot saved to debug_key_extract.png")

                result["success"] = True
                result["api_key"] = api_key
                result["key_name"] = key_name
                self.log(f"[SUCCESS] API key created: {key_name}")

            except PlaywrightTimeout as e:
                self.error = f"Timeout: {e}"
                result["error"] = self.error
                self.log(f"[ERROR] {self.error}")
                page.screenshot(path="debug_timeout.png")

            except Exception as e:
                self.error = str(e)
                result["error"] = self.error
                self.log(f"[ERROR] {self.error}")
                try:
                    page.screenshot(path="debug_error.png")
                except Exception:
                    pass

            finally:
                browser.close()

        return result


def main():
    parser = argparse.ArgumentParser(description="xAI API Key Farmer")
    parser.add_argument("--email", "-e", required=True, help="xAI account email")
    parser.add_argument("--password", "-p", required=True, help="xAI account password")
    parser.add_argument("--output", "-o", help="Output JSON file")
    parser.add_argument("--headless", action="store_true", default=True, help="Run headless (default: True)")
    parser.add_argument("--no-headless", dest="headless", action="store_false", help="Run with visible browser")
    args = parser.parse_args()

    print("=" * 60)
    print("xAI API Key Farmer")
    print("=" * 60)
    print(f"Email: {args.email}")
    print(f"Headless: {args.headless}")
    print("=" * 60)

    farmer = XaiApiKeyFarmer(args.email, args.password, headless=args.headless)
    result = farmer.run()

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
    sys.exit(main())
