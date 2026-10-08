@echo off
rem ============================================================
rem  STI Harness launcher  (double-click to run)
rem  Copyright 2026 liwei (YiZhiRui Xi'an).
rem
rem  Keep this file PURE ASCII.  Non-ASCII bytes here break
rem  cmd.exe parsing after "chcp 65001" (the parser splits lines
rem  at the wrong byte offsets and starts running comments as
rem  commands).  The same rule applies to check.cmd.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

rem Use "node -v", NOT "where node": a Microsoft Store node stub
rem answers "where" just fine but cannot actually run anything.
node -v >nul 2>nul
if errorlevel 1 goto nonode

rem Show the project version when VERSION exists (best effort).
set "STI_VER="
if exist "VERSION" set /p STI_VER=<VERSION

rem The address printed below must follow STI_PORT, otherwise the
rem hint is wrong whenever the port has been changed.
set "STI_PORT_LOCAL=%STI_PORT%"
if "%STI_PORT_LOCAL%"=="" set "STI_PORT_LOCAL=3090"

echo.
echo Starting STI Harness %STI_VER% ...  (press Ctrl+C to stop)
echo   Then open in browser:  http://127.0.0.1:%STI_PORT_LOCAL%
echo   (port from STI_PORT if you set it, otherwise 3090)
echo   Do NOT open public\index.html directly.
echo.

node app\main.mjs
set "RC=%ERRORLEVEL%"

echo.
echo STI Harness has exited.  Exit code: %RC%
echo If it failed to start, run check.cmd for a self-check report.
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
