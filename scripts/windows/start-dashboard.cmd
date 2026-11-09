@echo off
rem Starts the GMS dashboard and opens it in the browser.
rem
rem   start-dashboard.cmd                    the main campaign, port 4600
rem   start-dashboard.cmd gobadiz 4601       campaigns\gobadiz, on its own port
rem
rem The port must match ui.port in that campaign's gms.config.yaml.
rem
rem Keep this window open while you work: closing it stops the dashboard and
rem any scrape started from it. Minimise it instead. Disconnecting from Remote
rem Desktop is fine; signing out of Windows is not.
title GMS dashboard %~1
cd /d "%~dp0..\.."

set "DASHBOARD_ARGS="
set "DASHBOARD_PORT=4600"
if not "%~1"=="" set "DASHBOARD_ARGS=--campaign %~1"
if not "%~2"=="" set "DASHBOARD_PORT=%~2"

rem Already running (from the Startup folder, say)? Just open it.
netstat -ano | findstr /r /c:"127\.0\.0\.1:%DASHBOARD_PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo The dashboard is already running. Opening it in the browser.
  start "" http://127.0.0.1:%DASHBOARD_PORT%
  exit /b 0
)

node dist\cli\main.js %DASHBOARD_ARGS% ui --control --port %DASHBOARD_PORT%
if errorlevel 1 pause
