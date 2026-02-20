#!/usr/bin/env bash
set -euo pipefail

PYTHON_VERSION="${PYTHON_VERSION:-3.12}"
SKIP_NODE="${SKIP_NODE:-0}"
SKIP_FRONTEND="${SKIP_FRONTEND:-0}"
SKIP_BACKEND="${SKIP_BACKEND:-0}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

step() {
  echo
  echo "==> $1"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

install_uv_if_missing() {
  if has_cmd uv; then
    echo "uv detected: $(uv --version)"
    echo "uv path: $(command -v uv)"
    return
  fi

  step "uv not found, installing via official script"
  if has_cmd curl; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
  elif has_cmd wget; then
    wget -qO- https://astral.sh/uv/install.sh | sh
  else
    echo "Error: curl/wget not found, cannot install uv automatically." >&2
    exit 1
  fi

  export PATH="$HOME/.local/bin:$PATH"
  if ! has_cmd uv; then
    echo "Error: uv installed but not in PATH. Reopen terminal and rerun ./setup.sh" >&2
    exit 1
  fi
  echo "uv installed: $(uv --version)"
  echo "uv path: $(command -v uv)"
}

install_node_if_missing() {
  if has_cmd node && has_cmd npm; then
    echo "Node detected: $(node --version), npm: $(npm --version)"
    echo "node path: $(command -v node)"
    echo "npm path: $(command -v npm)"
    return
  fi

  step "Node.js not found, installing Node.js LTS"
  if has_cmd apt-get; then
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl gnupg
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
    sudo apt-get update
    sudo apt-get install -y nodejs
  elif has_cmd dnf; then
    sudo dnf install -y nodejs npm
  elif has_cmd yum; then
    sudo yum install -y nodejs npm
  elif has_cmd pacman; then
    sudo pacman -Sy --noconfirm nodejs npm
  elif has_cmd brew; then
    brew install node
  else
    echo "Error: unsupported package manager. Install Node.js LTS manually." >&2
    exit 1
  fi

  if ! has_cmd node || ! has_cmd npm; then
    echo "Error: Node.js install failed." >&2
    exit 1
  fi
  echo "Node installed: $(node --version), npm: $(npm --version)"
  echo "node path: $(command -v node)"
  echo "npm path: $(command -v npm)"
}

setup_backend() {
  step "Setting up Python with uv"
  uv python install "$PYTHON_VERSION"
  uv venv --python "$PYTHON_VERSION" .venv
  uv pip install --python ./.venv/bin/python -r requirements.txt
  echo "Backend ready. Python executable: ./.venv/bin/python"
  echo "Project venv location: $ROOT_DIR/.venv"
}

setup_frontend() {
  if [[ ! -f "./frontend/package.json" ]]; then
    echo "frontend/package.json not found, skipping frontend install."
    return
  fi
  step "Installing frontend dependencies"
  npm --prefix frontend install
  echo "Frontend dependencies installed."
}

step "Bootstrap start (root: $ROOT_DIR)"

install_uv_if_missing

if [[ "$SKIP_BACKEND" != "1" ]]; then
  setup_backend
else
  echo "SKIP_BACKEND=1, backend setup skipped."
fi

if [[ "$SKIP_NODE" != "1" ]]; then
  install_node_if_missing
else
  echo "SKIP_NODE=1, Node.js setup skipped."
fi

if [[ "$SKIP_FRONTEND" != "1" ]]; then
  setup_frontend
else
  echo "SKIP_FRONTEND=1, frontend setup skipped."
fi

step "All done"
echo "Install location note (Linux/macOS):"
echo "- Project Python env is always in: $ROOT_DIR/.venv"
echo "- Node.js install location depends on package manager:"
echo "  apt/dnf/yum/pacman/brew usually place binaries under /usr/bin, /usr/local/bin, or Homebrew prefix."
echo "Use backend: ./.venv/bin/python -m uvicorn api.main:app --host 0.0.0.0 --port 8000"
echo "Use frontend: npm --prefix frontend run dev"
