@echo off
setlocal EnableDelayedExpansion
title FillGST Local Helper

echo.
echo  ===================================================
echo   FillGST Local Helper - starting...
echo  ===================================================
echo.

REM ── Check if Node.js is installed ─────────────────────
where node >nul 2>nul
if errorlevel 1 (
    echo  [!] Node.js is not installed.
    echo.
    echo  This helper needs Node.js v20 or later.
    echo  Opening the download page in your browser...
    echo.
    start https://nodejs.org/en/download/
    echo  After installing Node.js, close this window
    echo  and double-click start.bat again.
    echo.
    pause
    exit /b 1
)

REM ── Check Node version ────────────────────────────────
for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
echo  Found Node.js !NODE_VERSION!

REM ── Run first-time setup if needed ────────────────────
if not exist "node_modules" (
    echo.
    echo  First-time setup. This will take 2-3 minutes.
    echo.
    echo  [1/2] Installing dependencies...
    call npm install --silent
    if errorlevel 1 (
        echo  [!] npm install failed. Try running as Administrator.
        pause
        exit /b 1
    )
    echo        Done.
    echo.
    echo  [2/2] Downloading Chromium browser ^(~150 MB, one-time^)...
    call npx playwright install chromium
    if errorlevel 1 (
        echo  [!] Chromium download failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo        Done.
    echo.
)

REM ── Build TypeScript if needed ────────────────────────
if not exist "dist\server.js" (
    echo  Building...
    call npm run build --silent
    if errorlevel 1 (
        echo  [!] Build failed.
        pause
        exit /b 1
    )
    echo  Built.
    echo.
)

REM ── Start the helper ──────────────────────────────────
echo  ===================================================
echo   Starting FillGST Local Helper on port 9876
echo  ===================================================
echo.
echo   ^>^>^> Leave this window open while using FillGST.
echo   ^>^>^> Close this window to stop the helper.
echo.
echo   To start automatically with Windows, run install-startup.bat
echo.

call npm start
