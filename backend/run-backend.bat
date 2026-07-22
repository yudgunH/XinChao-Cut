@echo off
:: Production backend launcher -- invoked by the Tauri shell on app startup (and
:: runnable by hand). No --reload: one stable process bound to localhost.
:: %~dp0 = this backend folder, regardless of where the app is installed.
setlocal
set "D=%~dp0"
cd /d "%D%"

:: AI runtime lives in the PER-USER data dir (venvs + ffmpeg), NOT in the app
:: folder, so app updates never wipe it. Override with XINCHAO_AI_DIR.
if not defined XINCHAO_AI_DIR set "XINCHAO_AI_DIR=%LOCALAPPDATA%\XinChao-Cut"
:: Data dir (models / voices / music / jobs) can live on another drive to save
:: SSD — set in the app ("Thư mục dữ liệu"), stored in data-dir.txt. The venvs +
:: ffmpeg always stay under XINCHAO_AI_DIR (fast, on C:). Falls back to AI_DIR\work.
if not defined XINCHAO_WORK_DIR (
  if exist "%XINCHAO_AI_DIR%\data-dir.txt" set /p XINCHAO_WORK_DIR=<"%XINCHAO_AI_DIR%\data-dir.txt"
)
if not defined XINCHAO_WORK_DIR set "XINCHAO_WORK_DIR=%XINCHAO_AI_DIR%\work"
if not defined XINCHAO_WHISPER_MODEL (
  if exist "%XINCHAO_AI_DIR%\whisper-model.txt" set /p XINCHAO_WHISPER_MODEL=<"%XINCHAO_AI_DIR%\whisper-model.txt"
)
set "TORCH_HOME=%XINCHAO_WORK_DIR%\torch-cache"
set "VMAIN=%XINCHAO_AI_DIR%\venv"
:: Interpreter for the isolated OmniVoice TTS worker (tts.py reads this env).
set "XINCHAO_OMNIVOICE_PYTHON=%XINCHAO_AI_DIR%\venv-omnivoice\Scripts\python.exe"
:: ffmpeg/ffprobe fetched by setup into the data dir.
set "PATH=%XINCHAO_AI_DIR%\bin;%PATH%"

:: HF runtime flags (must be set before Python imports huggingface_hub):
::  - no xet P2P proxy (would 401 on localhost:8080)
::  - no cache symlinks (Windows blocks them without admin -> WinError 1314)
set "HF_HUB_DISABLE_XET=1"
set "HF_HUB_DISABLE_SYMLINKS=1"
set "HF_HUB_DISABLE_SYMLINKS_WARNING=1"

if not exist "%XINCHAO_AI_DIR%" mkdir "%XINCHAO_AI_DIR%"
set "LOGFILE=%XINCHAO_AI_DIR%\backend.log"

:: Keep unattended installs from growing backend.log without bound. Rotate one
:: 50 MiB backup before any process writes to the active log.
if exist "%LOGFILE%" (
  for %%F in ("%LOGFILE%") do if %%~zF GTR 52428800 (
    if exist "%LOGFILE%.1" del /q "%LOGFILE%.1"
    move /y "%LOGFILE%" "%LOGFILE%.1" >nul
  )
)

if not exist "%VMAIN%\Scripts\python.exe" (
  >>"%LOGFILE%" echo [run-backend] %DATE% %TIME% venv missing at %VMAIN% -- run "Bat AI" setup first.
  exit /b 1
)

:: Log uvicorn output so a headless auto-start failure is diagnosable.
>>"%LOGFILE%" echo --- backend start %DATE% %TIME% (app dir: %D%) ---
"%VMAIN%\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 >>"%LOGFILE%" 2>&1
