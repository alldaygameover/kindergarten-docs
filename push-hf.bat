@echo off
cd /d "%~dp0"
echo.
echo ==========================================
echo  Push to Hugging Face Spaces
echo ==========================================
echo.
echo Before running this, create a Docker Space at:
echo https://huggingface.co/new-space
echo.
echo   - Owner: alldaygameover
echo   - Name:   kindergarten-docs
echo   - SDK:    Docker
echo.
echo Then get your HF token from:
echo https://huggingface.co/settings/tokens
echo.
set /p HF_TOKEN="Paste your HF token (with write access): "
if "%HF_TOKEN%"=="" (
  echo No token entered. Exiting.
  pause
  exit /b 1
)
git remote remove hf 2>nul
git remote add hf https://alldaygameover:%HF_TOKEN%@huggingface.co/spaces/alldaygameover/kindergarten-docs
git add .
git commit -m "Deploy to Hugging Face Spaces" 2>nul
git push hf main
echo.
echo Done! Check: https://huggingface.co/spaces/alldaygameover/kindergarten-docs
echo.
echo Next: set secrets in Space Settings, then add Google OAuth redirect URI.
pause