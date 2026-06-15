@echo off
cd /d "%~dp0backend"
call .venv\Scripts\activate
uvicorn app.main:app --port 8000 --reload
pause
