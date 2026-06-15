@echo off
cd /d "%~dp0"
echo.
echo ========================================
echo  Kindergarten Docs - Cloudflare Tunnel
echo ========================================
echo.
echo Step 1: Starting web app on port 8765...
start "Kindergarten Docs App" cmd /k "cd /d %~dp0 && python -m uvicorn app.main:app --host 127.0.0.1 --port 8765"
timeout /t 3 /nobreak >nul
echo.
echo Step 2: Starting Cloudflare Tunnel...
echo.
echo IMPORTANT: Copy the https://....trycloudflare.com URL shown below.
echo Then update APP_URL in .env and Google OAuth redirect URI.
echo.
cloudflared tunnel --url http://127.0.0.1:8765
pause