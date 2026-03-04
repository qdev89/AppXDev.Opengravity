@echo off
title Opengravity Server
cd /d "%~dp0"

echo.
echo   ================================
echo     Opengravity - AI Gateway
echo   ================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

:: Install deps if needed
if not exist "node_modules" (
    echo [SETUP] Installing dependencies...
    call npm install
    echo.
)

:: Start server
echo [START] Launching Opengravity...
echo.
node server.js

:: If server exits, pause so user can see errors
echo.
echo [STOPPED] Server has stopped.
pause
