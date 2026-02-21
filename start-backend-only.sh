#!/usr/bin/env bash
set -euo pipefail

BACKEND_HOST="${BACKEND_HOST:-0.0.0.0}"
BACKEND_PORT="${BACKEND_PORT:-8000}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ ! -x "./.venv/bin/python" ]]; then
  echo "Missing .venv/bin/python. Run ./install.sh first." >&2
  exit 1
fi

echo "Starting backend on http://${BACKEND_HOST}:${BACKEND_PORT}"
echo "Press Ctrl+C to stop"

./.venv/bin/python -m uvicorn api.main:app --host "$BACKEND_HOST" --port "$BACKEND_PORT"

cleanup() {
  echo
  echo "Stopping backend..."
}

trap cleanup INT TERM EXIT