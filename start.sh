#!/usr/bin/env bash
set -euo pipefail

BACKEND_HOST="${BACKEND_HOST:-0.0.0.0}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ ! -x "./.venv/bin/python" ]]; then
  echo "Missing .venv/bin/python. Run ./install.sh first." >&2
  exit 1
fi

if [[ ! -f "./frontend/package.json" ]]; then
  echo "Missing frontend/package.json." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Run ./install.sh first." >&2
  exit 1
fi

echo "Starting backend on http://localhost:${BACKEND_PORT}"
./.venv/bin/python -m uvicorn api.main:app --host "$BACKEND_HOST" --port "$BACKEND_PORT" &
BACKEND_PID=$!

echo "Starting frontend on http://localhost:${FRONTEND_PORT}"
(
  export PORT="$FRONTEND_PORT"
  npm --prefix frontend run dev
) &
FRONTEND_PID=$!

cleanup() {
  echo
  echo "Stopping services..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}

trap cleanup INT TERM EXIT
wait "$BACKEND_PID" "$FRONTEND_PID"
