@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "BACKEND_SETUP=%ROOT%backend\setup.bat"
set "NPM_CMD="

title XinChao-Cut Setup
cd /d "%ROOT%"

echo.
echo ========================================
echo   XinChao-Cut - Initial setup
echo ========================================
echo.

for /f "delims=" %%I in ('where npm.cmd 2^>nul') do if not defined NPM_CMD set "NPM_CMD=%%I"
if not defined NPM_CMD (
  echo [ERROR] Node.js and npm were not found.
  echo Install Node.js 22 LTS, reopen this window, then run setup.bat again.
  exit /b 1
)

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Windows PowerShell was not found.
  exit /b 1
)

if not exist "%BACKEND_SETUP%" (
  echo [ERROR] Missing backend\setup.bat.
  exit /b 1
)

echo [1/2] Installing exact frontend dependencies...
call "%NPM_CMD%" ci
if errorlevel 1 (
  echo.
  echo [ERROR] npm ci failed. Check the Node.js version and network connection.
  exit /b 1
)

echo.
echo [2/2] Installing the Core backend and pinned FFmpeg...
echo       AI model packages are intentionally skipped.
call "%BACKEND_SETUP%" -Components core
if errorlevel 1 (
  echo.
  echo [ERROR] Core backend setup failed.
  echo Python 3.11 x64 must be installed and available in PATH.
  exit /b 1
)

echo.
echo ========================================
echo   Setup completed successfully
echo ========================================
echo.
echo Next steps:
echo   1. Run start.bat to open the desktop development app.
echo   2. Click the backend status icon, then "Quan ly model"
echo      to add WhisperX, FunASR, Demucs, or OmniVoice.
echo.
echo Note: Tauri development also needs Rust, Microsoft C++ Build Tools,
echo and WebView2. See README.md for the complete requirements.
echo.
exit /b 0
