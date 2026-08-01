# 测试 Narrative Bridge 就绪文件的协议内容与退出清理。
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from narrativeBridge.readiness import publish_runtime_ready


def test_publish_and_cleanup_runtime_ready(tmp_path: Path, monkeypatch) -> None:
    ready_file = tmp_path / "narrative-bridge.ready.json"
    monkeypatch.setenv("EMA_READY_FILE", str(ready_file))
    monkeypatch.setenv("EMA_RUNTIME_NONCE", "runtime-nonce")
    monkeypatch.setenv("EMA_RUNTIME_PROTOCOL_VERSION", "1")
    monkeypatch.setenv("EMA_NARRATIVE_BRIDGE_PORT", "7421")

    cleanup = publish_runtime_ready()
    assert json.loads(ready_file.read_text(encoding="utf-8")) == {
        "service": "narrative-bridge",
        "pid": os.getpid(),
        "port": 7421,
        "nonce": "runtime-nonce",
        "protocolVersion": 1,
    }
    assert cleanup is not None
    cleanup()
    assert not ready_file.exists()


def test_reject_incompatible_runtime_protocol(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv(
        "EMA_READY_FILE",
        str(tmp_path / "narrative-bridge.ready.json"),
    )
    monkeypatch.setenv("EMA_RUNTIME_NONCE", "runtime-nonce")
    monkeypatch.setenv("EMA_RUNTIME_PROTOCOL_VERSION", "2")
    monkeypatch.setenv("EMA_NARRATIVE_BRIDGE_PORT", "7421")
    with pytest.raises(RuntimeError, match="runtime protocol mismatch"):
        publish_runtime_ready()
