# xAI (Grok) Farm

Automated xAI account registration using OAuth Device Code Flow + Camoufox browser automation.

## Features

- **No API credits required** — Uses Grok CLI's public OAuth client
- **Automated registration** — Camoufox browser + IMAP OTP retrieval
- **Project-local browser** — Camoufox cache stored in `.camoufox/`
- **Configurable** — All settings via Mirais Settings UI

## Setup

### 1. Install Dependencies

```bash
# Windows
scripts\xfarm\install.bat

# Linux/Mac
pip install -r scripts/xfarm/requirements.txt
python -m playwright install chromium
```

### 2. Configure Settings

1. Open Mirais Dashboard → Settings → **XAI IMAP Settings**
2. Enable **xAI farming**
3. Enter **Gmail address** (receives forwarded OTP emails)
4. Enter **Gmail App Password** (16 characters)
   - Create at: Google Account → Security → 2-Step Verification → App passwords
5. Set **Email domain** (e.g., `levanza.my.id`)
6. Save

### 3. Email Routing

Make sure your domain forwards all emails to the Gmail address:

```
*@levanza.my.id → your.email@gmail.com
```

## Usage

### Via Dashboard

1. Go to **Providers** → Add **xAI** provider
2. Click **Farm Account** button
3. Wait for automation to complete
4. Account is automatically added

### Via CLI (for testing)

```bash
# Using settings from Mirais
python scripts/xfarm/farm.py --config settings.json

# Or with environment variables
export GMAIL_USERNAME="your.email@gmail.com"
export GMAIL_APP_PASSWORD="abcd efgh ijkl mnop"
export EMAIL_DOMAIN="levanza.my.id"
python scripts/xfarm/farm.py
```

## How It Works

```
1. Generate random email (e.g., swiftfox123@levanza.my.id)
2. Request OAuth device code from x.ai
3. Launch Camoufox → accounts.x.ai/sign-up
4. Fill registration form
5. Wait for OTP email (IMAP Gmail)
6. Enter OTP → complete registration
7. Navigate to device authorization URL
8. Click "Authorize"
9. Poll for OAuth token
10. Save access_token to Mirais
```

## File Structure

```
scripts/xfarm/
├── farm.py              # Main Python bot
├── index.ts             # Node.js wrapper
├── requirements.txt     # Python dependencies
├── .env.example         # Environment template
├── install.bat          # Windows installer
└── README.md            # This file

.camoufox/               # Browser cache (auto-created)
```

## Available Models

After successful farm, these models are available:

- `grok-build`
- `grok-4.5`
- `grok-4.5-high`
- `grok-4.5-medium`
- `grok-4.5-low`

## Troubleshooting

### "Missing dependencies"
```bash
pip install camoufox playwright python-dotenv
python -m playwright install chromium
```

### "Gmail login failed"
- Make sure IMAP is enabled in Gmail Settings
- Use App Password (not regular password)
- Check username is correct

### "OTP not found"
- Check email routing is working
- Verify Gmail receives forwarded emails
- Increase `otp_max_retries` in settings

### "Authorization pending"
- The script should auto-click "Authorize"
- If not, manually click in the browser window
- Check if CAPTCHA is blocking (disable headless mode)

## Security Notes

- **Never commit** `.env` or `.camoufox/` to git
- App Password is sensitive — store securely
- Farmed accounts are for personal use only
- Respect x.ai's Terms of Service
