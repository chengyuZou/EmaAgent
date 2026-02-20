param(
    [string]$BackendHost = "0.0.0.0",
    [int]$BackendPort = 8000
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $ProjectRoot

function Require-Path {
    param(
        [string]$PathValue,
        [string]$Hint
    )
    if (-not (Test-Path $PathValue)) {
        throw "Missing: $PathValue. $Hint"
    }
}

function Require-Command {
    param(
        [string]$Name,
        [string]$Hint
    )
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Command not found: $Name. $Hint"
    }
}

Require-Path ".\.venv\Scripts\python.exe" "Run .\setup.ps1 first."

Write-Host "Starting backend server..." -ForegroundColor Green
Write-Host "Host: $BackendHost" -ForegroundColor Cyan
Write-Host "Port: $BackendPort" -ForegroundColor Cyan
Write-Host ""

$backendCmd = "Set-Location '$ProjectRoot'; Write-Host 'Backend server is running at http://$BackendHost`:$BackendPort' -ForegroundColor Yellow; Write-Host 'Press Ctrl+C to stop' -ForegroundColor Yellow; Write-Host ''; .\.venv\Scripts\python.exe -m uvicorn api.main:app --host $BackendHost --port $BackendPort"

# Start backend in current window (so Ctrl+C works properly)
Write-Host "Starting backend in this window..." -ForegroundColor Green
Invoke-Expression $backendCmd

# If we get here, backend has stopped
Write-Host ""
Write-Host "Backend server has stopped." -ForegroundColor Red