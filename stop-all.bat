@echo off
rem Career OS stop — kill tracked process trees + clean runtime state
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=%~dp0.local\node\node.exe"
if not exist "%NODE%" (echo [ERROR] embedded node not found: %NODE% & pause & exit /b 1)
"%NODE%" "runtime/stop-all.mjs"
pause
