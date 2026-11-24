@echo off
setlocal
chcp 65001 >nul
title OCS AI Answerer - Local Server
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto run
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe" & goto run
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe" & goto run
goto nonode

:run
"%NODE%" "ocs-ai-server.mjs" %*
echo.
echo Server stopped.
pause
exit /b 0

:nonode
echo.
echo   [X] Node.js not found.
echo.
echo   Install Node.js LTS first:  https://nodejs.org/
echo   After installing, reopen this window and run start.bat again.
echo.
pause
exit /b 1
