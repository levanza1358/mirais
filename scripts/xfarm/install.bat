@echo off
REM Install xAI Farm dependencies
echo ============================================
echo xAI Farm - Installation
echo ============================================
echo.

set "ROOT=%~dp0..\.."
set "VENV_PYTHON=%ROOT%\.venv\Scripts\python.exe"
set "PYTHONUTF8=1"

REM Create installation-local Python environment
py -3 --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.8+ first.
    echo Download from: https://www.python.org/downloads/
    exit /b 1
)

echo [OK] Python found
if not exist "%VENV_PYTHON%" py -3 -m venv "%ROOT%\.venv"
if errorlevel 1 exit /b 1

REM Create .camoufox directory in project root
echo.
echo [INFO] Creating .camoufox cache directory...
if not exist "%ROOT%\.camoufox" mkdir "%ROOT%\.camoufox"
echo [OK] Camoufox cache: %ROOT%\.camoufox

REM Install Python packages
echo.
echo [INFO] Installing Python packages...
"%VENV_PYTHON%" -m pip install -r "%~dp0requirements.txt"

if errorlevel 1 (
    echo [ERROR] Failed to install Python packages
    exit /b 1
)

echo [OK] Python packages installed

REM Install Camoufox browser into the project cache
echo.
echo [INFO] Installing Camoufox browser...
"%VENV_PYTHON%" -c "import runpy,sys; from pathlib import Path; import camoufox.pkgman as p; p.INSTALL_DIR=Path(sys.argv[1]); sys.argv=['camoufox','fetch']; runpy.run_module('camoufox',run_name='__main__')" "%ROOT%\.camoufox"

if errorlevel 1 (
    echo [ERROR] Camoufox browser install failed
    exit /b 1
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
echo 4. Set email domain (e.g., example.com)
echo 5. Click "Farm Account" on xAI provider page
echo.
echo Note: Python packages are stored in .venv/ and Camoufox in .camoufox/
echo.
