#!/usr/bin/env python3
"""Debug helper: drive the Atria Google flow and dump what the page looks like.

Usage:
  python _debug-google.py --email a@b.com --password secret [--headed]

Writes screenshots + DOM dumps to .atria-profiles/<hash>/debug/ so a failure can
be inspected without re-running the whole job. Not part of the shipped pipeline.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass

from camoufox.sync_api import Camoufox  # type: ignore

KEYS_URL = "https://api.atria-asi.ai/console/keys"


def dump(page, out_dir: Path, tag: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        page.screenshot(path=str(out_dir / f"{tag}.png"), full_page=True)
    except Exception as error:  # noqa: BLE001
        print(f"[debug] screenshot failed: {error}")
    try:
        html = page.content()
        (out_dir / f"{tag}.html").write_text(html, encoding="utf-8")
        print(f"[debug] {tag}: url={page.url}")
    except Exception as error:  # noqa: BLE001
        print(f"[debug] content failed: {error}")
    try:
        info = page.evaluate(
            """() => {
                const out = [];
                for (const el of document.querySelectorAll('input')) {
                    out.push({
                        type: el.type,
                        name: el.name,
                        id: el.id,
                        ariaHidden: el.getAttribute('aria-hidden'),
                        tabindex: el.getAttribute('tabindex'),
                        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
                        placeholder: el.getAttribute('placeholder'),
                    });
                }
                return { title: document.title, inputs: out, bodyStart: (document.body ? document.body.innerText : '').slice(0, 400) };
            }"""
        )
        print(f"[debug] {tag} inputs: {json.dumps(info['inputs'], indent=2)}")
        print(f"[debug] {tag} title={info['title']!r} body={info['bodyStart']!r}")
    except Exception as error:  # noqa: BLE001
        print(f"[debug] evaluate failed: {error}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    profile = Path(args.profile)
    profile.mkdir(parents=True, exist_ok=True)
    out_dir = profile / "debug"

    with Camoufox(headless=not args.headed, persistent_context=True,
                  user_data_dir=str(profile), humanize=True) as context:
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(KEYS_URL, wait_until="domcontentloaded", timeout=60_000)
        time.sleep(3)
        dump(page, out_dir, "01-console")

        for label in ("Continue with Google", "Sign in with Google", "Google"):
            button = page.get_by_role("button", name=label)
            if button.count() and button.first.is_visible():
                button.first.click()
                print(f"[debug] clicked {label!r}")
                break
        time.sleep(5)
        dump(page, out_dir, "02-after-google-click")

        email_field = None
        for selector in ('#identifierId', 'input[name="identifier"]',
                         'input[type="email"]', 'input[name="YPqjbf"]'):
            candidate = page.locator(selector).first
            if candidate.count() and candidate.is_visible():
                email_field = candidate
                print(f"[debug] email selector matched: {selector}")
                break
        if email_field is not None:
            email_field.click()
            email_field.type(args.email, delay=25)
            print(f"[debug] typed email, field value length = {len(email_field.input_value())}")
            page.keyboard.press("Enter")
            print("[debug] submitted email")
        else:
            print("[debug] NO visible email field found")
        time.sleep(6)
        dump(page, out_dir, "03-after-email")

        # Poll for a visible password input for a while, dumping the state.
        for attempt in range(6):
            time.sleep(5)
            dump(page, out_dir, f"04-password-{attempt}")
            pw = page.locator('input[type="password"]:not([aria-hidden="true"])')
            visible = [i for i in range(pw.count()) if pw.nth(i).is_visible()]
            print(f"[debug] attempt {attempt}: visible password inputs = {visible}")
            if visible:
                pw.nth(visible[0]).fill(args.password)
                page.keyboard.press("Enter")
                print("[debug] submitted password")
                time.sleep(8)
                dump(page, out_dir, "05-after-password")
                break

        # The Google OAuth consent screen ("Continue"/"Lanjutkan") must be accepted
        # before Google redirects back to Atria. Google localises the label.
        for label in ("Continue", "Lanjutkan", "Allow", "Izinkan"):
            btn = page.get_by_role("button", name=label)
            if btn.count() and btn.first.is_visible():
                btn.first.click()
                print(f"[debug] clicked consent '{label}'")
                time.sleep(8)
                dump(page, out_dir, "06-after-consent")
                break
        else:
            print("[debug] no consent button found")

        print(f"[debug] done. Artifacts in {out_dir}")
        return


if __name__ == "__main__":
    main()
