@echo off
chcp 65001 >nul
title Career OS 一键启动
echo 启动 Career OS（引擎 + 前端）...
echo 日志：logs\engine.log · 按 Ctrl+C 退出
where node >nul 2>nul || (echo [错误] 未找到 node，请先安装 Node 24+ & pause & exit /b 1)
node "%~dp0start-all.mjs"
pause
