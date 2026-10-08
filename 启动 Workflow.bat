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
echo Using the last Provider selected in AI Settings.
set "providerLabel=Saved AI Settings"

:check_common
where node >nul 2>nul
>> "%startupLog%" echo Node check exit: %ERRORLEVEL%
if errorlevel 1 goto node_missing

where pnpm >nul 2>nul
>> "%startupLog%" echo pnpm check exit: %ERRORLEVEL%
if errorlevel 1 goto pnpm_missing

goto check_port

:check_port
powershell.exe -NoProfile -Command "try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 2; if ($health.ok) { exit 0 } } catch {}; exit 1"
if not errorlevel 1 goto already_running
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
>> "%startupLog%" echo Starting pnpm start
node "scripts\workflow-launcher.mjs"
set "workflowExit=%ERRORLEVEL%"
>> "%startupLog%" echo launcher monitor exit: %workflowExit%
echo.
if not "%workflowExit%"=="0" goto startup_failed
echo Workflow stopped.
pause
exit /b 0

:node_missing
>> "%startupLog%" echo Node missing
echo [ERROR] Node not found. Install Node.js 20 or newer and add node to PATH.
goto fail

:pnpm_missing
>> "%startupLog%" echo pnpm missing
echo [ERROR] pnpm not found. Install pnpm and add pnpm to PATH.
goto fail

:already_running
>> "%startupLog%" echo Existing Workflow service is healthy
echo Workflow is already running. Opening the browser.
start "" "http://localhost:3000"
exit /b 0

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
