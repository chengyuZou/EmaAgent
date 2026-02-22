param(
    [string]$BackendHost = "0.0.0.0",
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 5173
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
Require-Path ".\frontend\package.json" "frontend package.json is required."

# Refresh PATH from system/user env vars (needed after nvm/Node install in a fresh session)
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
$env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ";"

# Also try nvm's default Node symlink location in case PATH isn't updated yet
$nvmSymlink = [Environment]::GetEnvironmentVariable("NVM_SYMLINK", "Machine")
if (-not $nvmSymlink) { $nvmSymlink = [Environment]::GetEnvironmentVariable("NVM_SYMLINK", "User") }
if (-not $nvmSymlink) { $nvmSymlink = "C:\Program Files\nodejs" }
if ((Test-Path $nvmSymlink) -and ($env:Path -notlike "*$nvmSymlink*")) {
    $env:Path = "$nvmSymlink;$env:Path"
}

Require-Command "npm" "Install Node.js (managed by nvm-windows in .\setup.ps1)."

$backendCmd = "Set-Location '$ProjectRoot'; .\.venv\Scripts\python.exe -m uvicorn api.main:app --host $BackendHost --port $BackendPort"
$frontendCmd = "Set-Location '$ProjectRoot'; `$env:PORT='$FrontendPort'; npm --prefix frontend run dev"

Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCmd | Out-Null
Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCmd | Out-Null

Write-Host "Backend started: http://localhost:$BackendPort"
Write-Host "Frontend started: http://localhost:$FrontendPort"
Write-Host "Two PowerShell windows were opened for backend/frontend logs."
