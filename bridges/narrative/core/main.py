# 启动 Narrative Bridge，并在 uvicorn 真正监听后向桌面宿主报告端口。
from __future__ import annotations

import socket
import os
import json
import sys
import time

import uvicorn

from .application import build_app


class NarrativeServer(uvicorn.Server):
    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await super().startup(sockets=sockets)
        if self.started:
            print(
                json.dumps({
                    "jsonrpc": "2.0",
                    "method": "narrative.ready",
                    "params": {"port": self.config.port},
                }, separators=(",", ":")),
                flush=True,
            )


def bind_socket() -> socket.socket:
    """预先绑定 OS 分配的端口, 交给 uvicorn 使用同一个 socket。"""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(socket.SOMAXCONN)
    listener.setblocking(False)
    return listener


def main() -> None:
    started_at = time.perf_counter()
    print(f"[narrative:startup] process entered pid={os.getpid()}", file=sys.stderr, flush=True)
    listener = bind_socket()
    port = listener.getsockname()[1]
    app = build_app()
    print(
        f"[narrative:startup] app constructed duration_s={time.perf_counter() - started_at:.3f}",
        file=sys.stderr,
        flush=True,
    )
    server = NarrativeServer(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            log_level="info",
            loop="asyncio",
            http="h11",
        )
    )
    app.state.uvicorn_server = server
    try:
        server.run(sockets=[listener])
    finally:
        listener.close()


if __name__ == "__main__":
    main()
