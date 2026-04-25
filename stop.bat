@echo off
title FillGST Local Helper - Stop

echo Stopping FillGST Local Helper...
taskkill /F /FI "WindowTitle eq FillGST Local Helper*" /T 2>nul
taskkill /F /IM node.exe /FI "MEMUSAGE gt 1" 2>nul

echo Done.
timeout /t 2 /nobreak >nul
exit
