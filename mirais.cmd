@echo off
rem mirais CLI wrapper for Windows — usage: mirais start^|stop^|restart^|status
set INFO=%ProgramData%\Mirais\install.json
if exist "%INFO%" (
	for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%INFO%' | ConvertFrom-Json).root"`) do set ROOT=%%i
	if defined ROOT bun run "%ROOT%\scripts\cli.ts" %* & goto :eof
)
bun run "%~dp0scripts\cli.ts" %*
