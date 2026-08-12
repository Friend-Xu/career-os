@echo off
rem Career OS stop — kill tracked process trees + clean runtime state
rem NOTE: keep this file pure ASCII - cmd parses bat files with the ANSI codepage,
rem UTF-8 Chinese/unicode chars corrupt the parse (GBK misread produces stray commands)
chcp 65001 >nul
cd /d "%~dp0"
rem embedded node is a required dependency; missing = broken install, fail fast
set "NODE=%~dp0.local\node\node.exe"
if exist "%NODE%" goto run
echo [ERROR] Node.js environment missing: %NODE%
echo   Install Node.js 24+ and place a portable copy (with npm) into %~dp0.local\node\
pause
exit /b 1
:run
"%NODE%" "runtime/stop-all.mjs"
pause
