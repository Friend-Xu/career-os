@echo off
rem Career OS one-click launcher (engine 5289 + UI 5288) - Runtime Safety Layer v1
rem NOTE: keep this file pure ASCII - cmd parses bat files with the ANSI codepage,
rem UTF-8 Chinese/unicode chars corrupt the parse (GBK misread produces stray commands)
chcp 65001 >nul
cd /d "%~dp0"
rem embedded node (project-local, .local/node/node.exe); fall back to system node (24+) if missing
set "NODE=%~dp0.local\node\node.exe"
if not exist "%NODE%" (
    where node >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Node.js 24+ not found.
        echo   Install: https://nodejs.org/ (bundles npm)
        echo   Or put a portable Node into %~dp0.local\node\
        pause & exit /b 1
    )
    set "NODE=node"
)
"%NODE%" "runtime/supervisor.mjs"
pause
