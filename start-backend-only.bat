@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-backend-only.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo.
  echo start-backend.bat failed with exit code %EXITCODE%.
  exit /b %EXITCODE%
)

echo.
echo Backend started successfully. Press Ctrl+C in the backend window to stop.
exit /b 0