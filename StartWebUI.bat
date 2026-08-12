@echo off
rem Career OS one-click launcher (engine 5289 + UI 5288) - Runtime Safety Layer v1
rem NOTE: keep this file pure ASCII - cmd parses bat files with the ANSI codepage,
rem UTF-8 Chinese/unicode chars corrupt the parse (GBK misread produces stray commands)
rem NOTE: avoid parentheses inside if blocks - a ")" inside an echo line closes the
rem block early and corrupts parsing; use goto structure instead of nested blocks
chcp 65001 >nul
cd /d "%~dp0"
rem embedded node (project-local, .local/node/node.exe); fall back to system node (24+) if missing
set "NODE=%~dp0.local\node\node.exe"
if exist "%NODE%" goto run
rem use `where node.exe` (not `where node`): system PATH may have a bash shim
rem named "node" without .exe that cmd cannot execute
where node.exe >nul 2>nul
if not errorlevel 1 goto use_system
echo [ERROR] Node.js 24+ not found.
echo   Install: https://nodejs.org/ bundles npm
echo   Or put a portable Node into %~dp0.local\node\
pause
exit /b 1
:use_system
set "NODE=node.exe"
:run
"%NODE%" "runtime/supervisor.mjs"
pause
