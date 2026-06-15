@echo off
cd /d "%~dp0"
echo Starting Kindergarten Docs Calendar...
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8765
pause