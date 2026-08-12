@echo off
rem Career OS one-click launcher (engine 5289 + UI 5288) - Runtime Safety Layer v1
rem NOTE: keep this file pure ASCII - cmd parses bat files with the ANSI codepage,
rem UTF-8 Chinese/unicode chars corrupt the parse (GBK misread produces stray commands)
rem NOTE: avoid parentheses inside if blocks - a ")" inside an echo line closes the
rem block early and corrupts parsing; use goto structure instead of nested blocks
chcp 65001 >nul
cd /d "%~dp0"
rem embedded node is a required dependency (project-local, .local/node/node.exe);
rem missing = broken install, fail fast with a clear message (no silent fallback)
set "NODE=%~dp0.local\node\node.exe"
if exist "%NODE%" goto run
echo [ERROR] Node.js environment missing: %NODE%
echo   Install Node.js 24+ and place a portable copy (with npm) into %~dp0.local\node\
echo   Or run: node scripts/install-deps.mjs  (system node 24+ required for bootstrap)
pause
exit /b 1
:run
"%NODE%" "runtime/supervisor.mjs"
pause
