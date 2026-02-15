param(
    [string]$PythonVersion = "3.12",
    [string]$NodeVersion = "lts",
    [switch]$SkipNode,
    [switch]$SkipFrontend,
    [switch]$SkipBackend
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $ProjectRoot

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Ensure-ExitCode {
    param(
        [string]$CommandLabel
    )
    if ($LASTEXITCODE -ne 0) {
        throw "$CommandLabel failed with exit code $LASTEXITCODE"
    }
}

function Has-Command {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Refresh-PathFromSystem {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($machinePath -and $userPath) {
        $env:Path = "$machinePath;$userPath"
    } elseif ($machinePath) {
        $env:Path = $machinePath
    } elseif ($userPath) {
        $env:Path = $userPath
    }
}

function Install-UvIfMissing {
    if (Has-Command "uv") {
        Write-Host "uv detected: $(uv --version)"
        return
    }

    Write-Step "uv not found, trying automatic install"
    if (Has-Command "winget") {
        winget install --id astral-sh.uv -e --accept-source-agreements --accept-package-agreements
        Ensure-ExitCode "winget install astral-sh.uv"
    } else {
        Write-Host "winget not found, fallback to official installer..."
        powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"
        Ensure-ExitCode "uv install script"
    }

    if (-not (Has-Command "uv")) {
        $candidatePath = Join-Path $env:USERPROFILE ".local\bin"
        if (Test-Path $candidatePath) {
            $env:Path = "$candidatePath;$env:Path"
        }
    }

    if (-not (Has-Command "uv")) {
        throw "uv install completed but current shell cannot find uv. Restart terminal and rerun .\setup.ps1"
    }

    Write-Host "uv installed: $(uv --version)"
    $uvCmd = Get-Command uv -ErrorAction SilentlyContinue
    if ($uvCmd) {
        Write-Host "uv path: $($uvCmd.Source)"
    }
}

function Install-NodeIfMissing {
    if ((Has-Command "node") -and (Has-Command "npm")) {
        Write-Host "Node detected: $(node --version), npm: $(npm --version)"
        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
        $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
        if ($nodeCmd) { Write-Host "node path: $($nodeCmd.Source)" }
        if ($npmCmd) { Write-Host "npm path: $($npmCmd.Source)" }
        return
    }

    Write-Step "Node.js not found, using nvm-windows"
    if (-not (Has-Command "nvm")) {
        if (Has-Command "winget") {
            winget install --id CoreyButler.NVMforWindows -e --accept-source-agreements --accept-package-agreements
            Ensure-ExitCode "winget install CoreyButler.NVMforWindows"
            Refresh-PathFromSystem
        } else {
            throw "nvm is missing and winget is unavailable. Install nvm-windows manually first."
        }
    }

    if (-not (Has-Command "nvm")) {
        $nvmDefaultPath = "C:\Program Files\nvm"
        if (Test-Path $nvmDefaultPath) {
            $env:Path = "$nvmDefaultPath;$env:Path"
        }
    }

    if (-not (Has-Command "nvm")) {
        throw "nvm install completed but current shell cannot find nvm. Restart terminal and rerun .\setup.ps1"
    }

    Write-Host "nvm detected. Installing Node version: $NodeVersion"
    nvm install $NodeVersion
    Ensure-ExitCode "nvm install $NodeVersion"

    nvm use $NodeVersion
    if ($LASTEXITCODE -ne 0) {
        Write-Host "nvm use $NodeVersion failed, trying 'nvm use $(nvm current)'..."
        nvm use (nvm current)
    }

    Refresh-PathFromSystem
    $nodeDefaultPath = "C:\Program Files\nodejs"
    if (Test-Path $nodeDefaultPath) {
        $env:Path = "$nodeDefaultPath;$env:Path"
    }

    if (-not (Has-Command "node") -or -not (Has-Command "npm")) {
        throw "Node.js install/use completed but current shell cannot find node/npm. Restart terminal and rerun .\setup.ps1"
    }

    $currentNode = node --version
    Write-Host "Node installed via nvm: $currentNode, npm: $(npm --version)"
    $nvmCmd = Get-Command nvm -ErrorAction SilentlyContinue
    if ($nvmCmd) { Write-Host "nvm path: $($nvmCmd.Source)" }
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($nodeCmd) { Write-Host "node path: $($nodeCmd.Source)" }
    if ($npmCmd) { Write-Host "npm path: $($npmCmd.Source)" }

    Write-Host "Installed Node versions:"
    nvm list
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Unable to list Node versions via nvm in this shell."
    }
}

function Setup-Backend {
    Write-Step "Setting up Python with uv"
    uv python install $PythonVersion
    Ensure-ExitCode "uv python install"

    uv venv --python $PythonVersion .venv
    Ensure-ExitCode "uv venv"

    uv pip install --python .\.venv\Scripts\python.exe -r requirements.txt
    Ensure-ExitCode "uv pip install -r requirements.txt"

    Write-Host "Backend ready. Python executable: .\.venv\Scripts\python.exe"
    Write-Host "Project venv location: $ProjectRoot\.venv"
}

function Setup-Frontend {
    if (-not (Test-Path ".\frontend\package.json")) {
        Write-Host "frontend\package.json not found, skipping frontend install."
        return
    }

    Write-Step "Installing frontend dependencies"
    npm --prefix frontend install
    Ensure-ExitCode "npm --prefix frontend install"
    Write-Host "Frontend dependencies installed."
}

Write-Step "Bootstrap start (root: $ProjectRoot)"

Install-UvIfMissing

if (-not $SkipBackend) {
    Setup-Backend
} else {
    Write-Host "SkipBackend enabled, backend setup skipped."
}

if (-not $SkipNode) {
    Install-NodeIfMissing
} else {
    Write-Host "SkipNode enabled, Node.js setup skipped."
}

if (-not $SkipFrontend) {
    Setup-Frontend
} else {
    Write-Host "SkipFrontend enabled, frontend setup skipped."
}

Write-Step "All done"
Write-Host "Install location note (Windows + nvm):"
Write-Host "- Project Python env is always in: $ProjectRoot\.venv"
Write-Host "- nvm usually installs to: C:\Program Files\nvm"
Write-Host "- Active node symlink is usually: C:\Program Files\nodejs"
Write-Host "- Selected Node version (requested): $NodeVersion"
Write-Host "Use backend: .\.venv\Scripts\python.exe -m uvicorn api.main:app --host 0.0.0.0 --port 8000"
Write-Host "Use frontend: npm --prefix frontend run dev"
