@echo off
rem Career OS one-click launcher (engine 5289 + UI 5288)
cd /d "%~dp0"
rem embedded node (project-local, .local/node/node.exe)
set "NODE=%~dp0.local\node\node.exe"
if not exist "%NODE%" (echo [ERROR] embedded node not found: %NODE% & pause & exit /b 1)
"%NODE%" "start-all.mjs"
pause
