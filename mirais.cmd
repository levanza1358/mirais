@echo off
rem mirais CLI wrapper for Windows — usage: mirais start^|stop^|restart^|status
bun run "%~dp0scripts\cli.ts" %*
