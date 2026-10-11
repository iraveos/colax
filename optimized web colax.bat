@echo off
rem Colax in your browser: installs what is missing, builds once, serves, opens.
rem The vault lives in this browser's own storage. Mail (IMAP) needs the
rem desktop app - a web page cannot open a mail socket.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is required to run Colax in the browser.
  echo   Install it from https://nodejs.org and double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies - first run only, this takes a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed. Check your network and try again.
    echo.
    pause
    exit /b 1
  )
)

if not exist dist\index.html (
  echo Building the web version - first run only...
  call npm run build
  if errorlevel 1 (
    echo.
    echo   The build failed. Run "npm run build" in this folder to see why.
    echo.
    pause
    exit /b 1
  )
)

echo Opening Colax in your browser...
node scripts\web-preview.mjs
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
