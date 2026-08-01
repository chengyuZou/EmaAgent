# 选择本地端口、写入发现文件并启动 Narrative Bridge。
from __future__ import annotations

import os
import pathlib
import socket
import sys

import uvicorn

from .application import build_app

BRIDGE_VERSION = "0.1.0"


def data_dir() -> pathlib.Path:
    path = pathlib.Path(
        os.environ.get("EMA_DATA_DIR", pathlib.Path.home() / ".ema-agent")
    )
    path.mkdir(parents=True, exist_ok=True)
    return path


def find_port(start: int = 7421, end: int = 7430) -> int:
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(
        f"端口 {start}–{end} 均被占用，可能已有 Narrative Bridge 正在运行"
    )


def main() -> None:
    if "--version" in sys.argv[1:]:
        print(f"ema-narrative-bridge {BRIDGE_VERSION}")
        return

    port_file = data_dir() / "narrative-bridge.port"
    port = find_port()
    os.environ["EMA_NARRATIVE_BRIDGE_PORT"] = str(port)
    port_file.write_text(str(port), encoding="utf-8")
    print(
        f"[narrative-bridge] starting on http://127.0.0.1:{port} "
        f"(port file: {port_file})",
        flush=True,
    )
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


if __name__ == "__main__":
    main()
