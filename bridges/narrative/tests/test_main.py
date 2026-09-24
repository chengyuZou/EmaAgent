# 验证 Narrative 的 JSON-RPC ready 只在 uvicorn 完成实际监听后发出.
from __future__ import annotations

import json
import socket

import pytest
import uvicorn
from fastapi import FastAPI

from core.main import NarrativeServer, bind_socket


@pytest.mark.asyncio
async def test_ready_notification_follows_actual_bind(capsys) -> None:
    listener = bind_socket()
    port = listener.getsockname()[1]
    config = uvicorn.Config(FastAPI(), host="127.0.0.1", port=port, log_level="error")
    server = NarrativeServer(config)
    config.load()
    server.lifespan = config.lifespan_class(config)
    try:
        await server.startup(sockets=[listener])
        message = json.loads(capsys.readouterr().out.strip())
        assert message == {
            "jsonrpc": "2.0",
            "method": "narrative.ready",
            "params": {"port": port},
        }
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass
    finally:
        await server.shutdown()
        listener.close()
