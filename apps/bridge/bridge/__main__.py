# 解析 Bridge 启动参数、绑定本地端口并交给 Uvicorn 托管。
"""
Entry point for `uv run ema-bridge` (and `python -m bridge`).

Scans ports 7421–7430 for the first free one, writes the chosen port to
{EMA_DATA_DIR}/bridge.port so apps/core can discover the URL without any
hardcoded port, then starts uvicorn.  The port file is deleted on exit.
"""
from __future__ import annotations

import os
import pathlib
import socket
import sys

import uvicorn

from bridge.main import build_app

BRIDGE_VERSION = "0.1.0"


def _data_dir() -> pathlib.Path:
    p = pathlib.Path(os.environ.get("EMA_DATA_DIR", pathlib.Path.home() / ".ema-agent"))
    p.mkdir(parents=True, exist_ok=True)
    return p


def _find_port(start: int = 7421, end: int = 7430) -> int:
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port in range {start}–{end}. Is another bridge already running?")


def main() -> None:
    if "--version" in sys.argv[1:]:
        print(f"ema-bridge {BRIDGE_VERSION}")
        return

    port_file = _data_dir() / "bridge.port"
    port = _find_port()
    os.environ["EMA_BRIDGE_PORT"] = str(port)
    port_file.write_text(str(port), encoding="utf-8")
    print(f"[bridge] starting on http://127.0.0.1:{port}  (port file: {port_file})")

    try:
        uvicorn.run(
            build_app,
            host="127.0.0.1",
            port=port,
            log_level="info",
            factory=True,
            loop="asyncio",
            http="h11",
        )
    finally:
        port_file.unlink(missing_ok=True)
        print("[bridge] port file removed")


if __name__ == "__main__":
    main()
