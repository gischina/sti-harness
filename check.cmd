@echo off
rem ============================================================
rem  STI Harness deployment self-check  (double-click to run)
rem  Copyright 2026 liwei (YiZhiRui Xi'an) <liwei@geoscene.cn>.
rem
rem  Runs diagnostics only.  It does NOT listen on a port, so it
rem  is safe to run while a service is already up.
rem  Output is plain text: copy everything and send it to your
rem  administrator.  Keep this file PURE ASCII (see start.cmd).
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

rem Use "node -v", NOT "where node": a Microsoft Store node stub
rem answers "where" just fine but cannot actually run anything.
node -v >nul 2>nul
if errorlevel 1 goto nonode

set "STI_VER="
if exist "VERSION" set /p STI_VER=<VERSION

echo STI Harness version: %STI_VER%
node app\main.mjs --check
set "RC=%ERRORLEVEL%"

echo.
echo ------------------ end of report ------------------
echo Copy everything above and send it to your administrator.
echo.
pause
exit /b %RC%

:nonode
echo.
echo [x] Node.js not found.
echo     Please install Node.js 22.13 or newer:  https://nodejs.org
echo     (node:sqlite needs 22.13+ to run without an experimental flag.)
echo.
pause
exit /b 1
