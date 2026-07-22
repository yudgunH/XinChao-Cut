@echo off
setlocal
set "SCRIPT=%~dp0setup.ps1"
if not exist "%SCRIPT%" (
  echo [ERROR] Missing setup.ps1 next to setup.bat.
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %ERRORLEVEL%
