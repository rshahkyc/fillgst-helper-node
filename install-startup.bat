@echo off
setlocal
title FillGST Local Helper - Auto-start setup

echo.
echo  ===================================================
echo   Setting up auto-start with Windows...
echo  ===================================================
echo.

REM Get the absolute path to start.bat in this folder
set "HELPER_PATH=%~dp0start.bat"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT=%STARTUP_DIR%\FillGST Helper.lnk"

REM Create a VBS script to make the shortcut (Windows native)
set "VBS=%TEMP%\fillgst_shortcut.vbs"
(
    echo Set oWS = WScript.CreateObject^("WScript.Shell"^)
    echo Set oLink = oWS.CreateShortcut^("%SHORTCUT%"^)
    echo oLink.TargetPath = "%HELPER_PATH%"
    echo oLink.WorkingDirectory = "%~dp0"
    echo oLink.WindowStyle = 7
    echo oLink.Description = "FillGST Local Helper"
    echo oLink.Save
) > "%VBS%"

cscript //nologo "%VBS%" >nul
del "%VBS%"

if exist "%SHORTCUT%" (
    echo  [OK] FillGST Helper will now start automatically when Windows boots.
    echo.
    echo  Shortcut created at:
    echo    %SHORTCUT%
    echo.
    echo  To remove auto-start later:
    echo    1. Press Win + R, type: shell:startup
    echo    2. Delete "FillGST Helper.lnk"
    echo.
) else (
    echo  [!] Could not create startup shortcut.
)

pause
