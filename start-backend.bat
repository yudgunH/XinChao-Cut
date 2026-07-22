@echo off
setlocal
set "BACKEND=%~dp0backend"
set "PYTHON=%BACKEND%\.venv\Scripts\python.exe"
if not exist "%PYTHON%" (
  echo [ERROR] Missing backend\.venv. Follow docs\INSTALLATION.md first.
  exit /b 1
)
set "HF_HUB_DISABLE_XET=1"
set "HF_HUB_DISABLE_SYMLINKS=1"
cd /d "%BACKEND%"
"%PYTHON%" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload --no-use-colors
