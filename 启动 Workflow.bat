@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if not exist ".runtime" mkdir ".runtime" >nul 2>nul
set "startupLog=.runtime\startup.log"
> "%startupLog%" echo [%date% %time%] Launcher started

echo ========================
echo.
echo AI Product Workflow
echo.
echo Select AI Provider:
echo.
echo 1. Local Codex
echo 2. Relay API
echo.
set "providerChoice="
set /p "providerChoice=Enter 1 or 2, then press Enter: "
>> "%startupLog%" echo Provider choice entered: %providerChoice%
if "%providerChoice%"=="1" goto select_codex
if "%providerChoice%"=="2" goto select_relay
goto invalid_choice

:select_codex
set "AI_PROVIDER=codex"
set "providerLabel=Codex Local"
>> "%startupLog%" echo Selected Codex Local
goto check_common

:select_relay
set "AI_PROVIDER=relay"
set "providerLabel=Relay"
>> "%startupLog%" echo Selected Relay
goto check_common

:check_common
where node >nul 2>nul
>> "%startupLog%" echo Node check exit: %ERRORLEVEL%
if errorlevel 1 goto node_missing

where pnpm >nul 2>nul
>> "%startupLog%" echo pnpm check exit: %ERRORLEVEL%
if errorlevel 1 goto pnpm_missing

if /i "%AI_PROVIDER%"=="codex" goto check_codex
goto check_port

:check_codex
set "OPENAI_API_KEY="
set "CODEX_API_KEY="
call codex --version >nul 2>nul
>> "%startupLog%" echo Codex version check exit: %ERRORLEVEL%
if errorlevel 1 goto codex_missing

call codex login status >nul 2>nul
>> "%startupLog%" echo Codex login check exit: %ERRORLEVEL%
if errorlevel 1 goto codex_login_invalid
goto check_port

:check_port
powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
>> "%startupLog%" echo Port check exit: %ERRORLEVEL%
if errorlevel 1 goto port_busy

echo.
echo ========================
echo Provider: %providerLabel%
echo Status: Starting
echo Browser: http://localhost:3000
echo ========================
echo.

:run_server
>> "%startupLog%" echo Starting pnpm dev with provider: %AI_PROVIDER%
node "scripts\workflow-launcher.mjs"
set "workflowExit=%ERRORLEVEL%"
>> "%startupLog%" echo launcher monitor exit: %workflowExit%
echo.
if not "%workflowExit%"=="0" goto startup_failed
echo Workflow stopped.
pause
exit /b 0

:invalid_choice
>> "%startupLog%" echo Invalid provider choice
echo [ERROR] Invalid selection. Enter 1 or 2.
goto fail

:node_missing
>> "%startupLog%" echo Node missing
echo [ERROR] Node not found. Install Node.js 20 or newer and add node to PATH.
goto fail

:pnpm_missing
>> "%startupLog%" echo pnpm missing
echo [ERROR] pnpm not found. Install pnpm and add pnpm to PATH.
goto fail

:codex_missing
>> "%startupLog%" echo Codex missing
echo [ERROR] Codex CLI not found. Install Codex CLI and add codex to PATH.
goto fail

:codex_login_invalid
>> "%startupLog%" echo Codex login invalid
echo [ERROR] Codex CLI login is invalid or expired.
echo Run "codex login" in a terminal, finish login, and start this file again.
goto fail

:port_busy
>> "%startupLog%" echo Port 3000 busy
echo [ERROR] Port 3000 is already in use. Stop the process using it and try again.
goto fail

:startup_failed
>> "%startupLog%" echo Startup failed with exit: %workflowExit%
echo [ERROR] Workflow failed to start. Exit code: %workflowExit%
echo Review the error above. Common causes: Provider initialization, login, or port conflicts.
pause
exit /b %workflowExit%

:fail
pause
exit /b 1
