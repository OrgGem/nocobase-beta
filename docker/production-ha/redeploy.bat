@echo off
title NocoBase HA Stack Redeployment
cd /d "%~dp0"
echo Starting NocoBase Redeployment & Upgrade Workflow...
powershell -NoProfile -ExecutionPolicy Bypass -File "redeploy.ps1"
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Redeployment workflow failed.
) else (
    echo.
    echo [SUCCESS] Redeployment workflow completed successfully!
)
pause
