@echo off
rem Career OS stop — kill tracked process trees + clean runtime state
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=%~dp0.local\node\node.exe"
if exist "%NODE%" goto run
where node.exe >nul 2>nul
if errorlevel 1 goto no_node
set "NODE=node.exe"
goto run
:no_node
echo [ERROR] Node.js 24+ not found.
echo   Install: https://nodejs.org/ bundles npm
echo   Or put a portable Node into %~dp0.local\node\
pause
exit /b 1
:run
"%NODE%" "runtime/stop-all.mjs"
pause
