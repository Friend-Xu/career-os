@echo off
rem Career OS one-click launcher (engine 5289 + UI 5288) — Runtime Safety Layer v1
chcp 65001 >nul
cd /d "%~dp0"
rem embedded node (project-local, .local/node/node.exe) — 缺失时回退系统 node（需 24+）
set "NODE=%~dp0.local\node\node.exe"
if not exist "%NODE%" (
    where node >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] 未找到 Node.js 24+。
        echo   安装: https://nodejs.org/ （自带 npm）
        echo   或将便携版 Node 放到 %~dp0.local\node\
        pause & exit /b 1
    )
    set "NODE=node"
)
"%NODE%" "runtime/supervisor.mjs"
pause
