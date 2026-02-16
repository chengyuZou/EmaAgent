@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo.
  echo start.bat failed with exit code %EXITCODE%.
  exit /b %EXITCODE%
)

echo.
echo start.bat finished successfully.
exit /b 0
