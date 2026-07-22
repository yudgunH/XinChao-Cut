@echo off
setlocal
set "ROOT=%~dp0"
set "BACKEND_PY=%LOCALAPPDATA%\XinChao-Cut\venv\Scripts\python.exe"
set "TAURI_CMD=%ROOT%node_modules\.bin\tauri.cmd"

rem Prefer the per-user runtime installed by install-models.bat. Keep the
rem repository venv as a development fallback for existing checkouts.
if not exist "%BACKEND_PY%" set "BACKEND_PY=%ROOT%backend\.venv\Scripts\python.exe"

if not exist "%BACKEND_PY%" (
  echo [ERROR] Missing Python runtime.
  echo Run install-models.bat and install at least one component first.
  exit /b 1
)
if not exist "%TAURI_CMD%" (
  echo [ERROR] Missing node_modules. Run npm ci first.
  exit /b 1
)
set "NPM_CMD="
for /f "delims=" %%I in ('where npm.cmd 2^>nul') do if not defined NPM_CMD set "NPM_CMD=%%I"
if not defined NPM_CMD (
  echo [ERROR] npm.cmd was not found in PATH. Install Node.js 20 or newer.
  exit /b 1
)

set "HF_HUB_DISABLE_XET=1"
set "HF_HUB_DISABLE_SYMLINKS=1"
set "VITE_BACKEND_URL=http://127.0.0.1:8000"
set "XINCHAO_EXTERNAL_BACKEND=1"

rem Never silently connect the new frontend to an old backend process. That
rem leaves Python code/filter graphs stale even though Vite hot-reloaded.
powershell.exe -NoLogo -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
  echo [ERROR] Port 8000 is already in use by an old backend.
  echo Close the previous Backend window/process, then run start.bat again.
  exit /b 1
)

rem Keep the Tauri resource fallback in sync with backend/app. `tauri dev` does
rem not run beforeBuildCommand, so without this step it can retain an older
rem FFmpeg graph even though the source backend has already been fixed.
call "%NPM_CMD%" run backend:stage
if errorlevel 1 (
  echo [ERROR] Could not stage the backend runtime.
  exit /b 1
)

rem Start the executable directly. Avoid cmd /k with nested quotes: on some
rem Windows cmd builds that made Python treat python.exe itself as source code.
start "XinChao-Cut Backend" /D "%ROOT%backend" "%BACKEND_PY%" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload --no-use-colors
start "XinChao-Cut Desktop" /D "%ROOT%" "%NPM_CMD%" run tauri dev

echo Backend:  http://127.0.0.1:8000
echo Desktop:  npm run tauri dev
echo Close the Tauri and Backend windows to stop development mode.
