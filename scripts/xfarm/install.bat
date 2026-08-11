@echo off
REM Install xAI Farm dependencies
echo ============================================
echo xAI Farm - Installation
echo ============================================
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.8+ first.
    echo Download from: https://www.python.org/downloads/
    exit /b 1
)

echo [OK] Python found
python --version

REM Create .camoufox directory in project root
echo.
echo [INFO] Creating .camoufox cache directory...
if not exist "%~dp0..\..\.camoufox" mkdir "%~dp0..\..\.camoufox"
echo [OK] Camoufox cache: %~dp0..\..\.camoufox

REM Install Python packages
echo.
echo [INFO] Installing Python packages...
pip install -r "%~dp0requirements.txt"

if errorlevel 1 (
    echo [ERROR] Failed to install Python packages
    exit /b 1
)

echo [OK] Python packages installed

REM Install Playwright browsers
echo.
echo [INFO] Installing Playwright browsers...
python -m playwright install chromium

if errorlevel 1 (
    echo [WARN] Playwright browser install failed, but continuing...
)

echo.
echo ============================================
echo [OK] Installation complete!
echo ============================================
echo.
echo Next steps:
echo 1. Go to Mirais Settings → XAI IMAP Settings
echo 2. Enable xAI farming
echo 3. Enter your Gmail address and App Password
echo 4. Set email domain (e.g., levanza.my.id)
echo 5. Click "Farm Account" on xAI provider page
echo.
echo Note: Camoufox browser data will be stored in .camoufox/
echo.
