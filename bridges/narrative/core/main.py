# 选择真实监听端口并启动 Narrative Bridge；端口经 ready 文件交给桌面宿主。
from __future__ import annotations

import socket

import uvicorn

from .application import build_app


def pick_port() -> int:
    """向 OS 申请一个空闲端口；桌面回环上没有竞争方，释放后由 uvicorn 直接监听。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def main() -> None:
    port = pick_port()
    app = build_app(port)
    server = uvicorn.Server(
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
    server.run()


if __name__ == "__main__":
    main()
