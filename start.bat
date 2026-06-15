@echo off
setlocal
:: %~dp0 expands to this script's directory with trailing backslash,
:: so %D%backend = <repo>\backend regardless of where the repo lives.
set "D=%~dp0"

title XinChao-Cut Launcher
echo Starting XinChao-Cut...

:: Disable hf_xet P2P protocol — its CAS proxy defaults to localhost:8080 which
:: doesn't exist here, causing 401 errors when loading WhisperX models.
:: Setting it here ensures the flag is visible before Python evaluates
:: huggingface_hub/constants.py (which freezes the value at first import).
set HF_HUB_DISABLE_XET=1

:: Kill any old instances
taskkill /F /FI "WINDOWTITLE eq XinChao-Cut Backend*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq XinChao-Cut Frontend*" >nul 2>&1

:: Backend (inherits HF_HUB_DISABLE_XET from this shell). Paths quoted so a
:: repo dir containing spaces still works.
:: --reload: pick up backend code edits without manually closing this window.
:: (Without it, a stale process keeps serving old code after you change a .py.)
start "XinChao-Cut Backend" cmd /k "set HF_HUB_DISABLE_XET=1 && cd /d "%D%backend" && .venv\Scripts\activate && uvicorn app.main:app --port 8000 --reload"

:: Frontend (start immediately, the polling hook handles the race)
start "XinChao-Cut Frontend" cmd /k "cd /d "%D:~0,-1%" && node_modules\.bin\vite.cmd --host"

echo.
echo Backend:  http://127.0.0.1:8000
echo Frontend: http://localhost:5173
echo.
echo Both windows opened. Close this window anytime.
timeout /t 3 /nobreak >nul
start http://localhost:5173
