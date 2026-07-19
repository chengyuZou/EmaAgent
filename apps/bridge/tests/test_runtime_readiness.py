# 测试 Bridge 就绪记录的协议校验、结构化内容和退出清理。
from __future__ import annotations

import json
import os

import pytest

from bridge.bootstrap.readiness import publish_runtime_ready


def test_publish_and_cleanup_runtime_ready(tmp_path, monkeypatch) -> None:
    ready_file = tmp_path / "bridge.ready.json"
    monkeypatch.setenv("EMA_READY_FILE", str(ready_file))
    monkeypatch.setenv("EMA_RUNTIME_NONCE", "runtime-nonce")
    monkeypatch.setenv("EMA_RUNTIME_PROTOCOL_VERSION", "1")
    monkeypatch.setenv("EMA_BRIDGE_PORT", "7421")

    cleanup = publish_runtime_ready()
    record = json.loads(ready_file.read_text(encoding="utf-8"))

    assert record == {
        "service": "bridge",
        "pid": os.getpid(),
        "port": 7421,
        "nonce": "runtime-nonce",
        "protocolVersion": 1,
    }
    assert cleanup is not None
    cleanup()
    assert not ready_file.exists()


def test_reject_incompatible_runtime_protocol(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EMA_READY_FILE", str(tmp_path / "bridge.ready.json"))
    monkeypatch.setenv("EMA_RUNTIME_NONCE", "runtime-nonce")
    monkeypatch.setenv("EMA_RUNTIME_PROTOCOL_VERSION", "2")
    monkeypatch.setenv("EMA_BRIDGE_PORT", "7421")

    with pytest.raises(RuntimeError, match="runtime protocol mismatch"):
        publish_runtime_ready()
