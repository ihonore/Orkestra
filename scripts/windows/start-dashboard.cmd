@echo off
rem Starts the GMS dashboard and opens it in the browser.
rem
rem Keep this window open while you work: closing it stops the dashboard and
rem any scrape started from it. Minimise it instead. Disconnecting from Remote
rem Desktop is fine; signing out of Windows is not.
title GMS dashboard
cd /d "%~dp0..\.."

rem Already running (from the Startup folder, say)? Just open it.
netstat -ano | findstr /r /c:"127\.0\.0\.1:4600 .*LISTENING" >nul
if not errorlevel 1 (
  echo The dashboard is already running. Opening it in the browser.
  start "" http://127.0.0.1:4600
  exit /b 0
)

node dist\cli\main.js ui --control
if errorlevel 1 pause
