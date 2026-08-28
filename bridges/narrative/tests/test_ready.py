# 测试 Narrative Bridge 就绪文件的内容与退出清理。
from __future__ import annotations

import json
from pathlib import Path

from core.ready import publish_ready


def test_publish_and_cleanup_ready(tmp_path: Path, monkeypatch) -> None:
    ready_file = tmp_path / "narrative-bridge.ready.json"
    monkeypatch.setenv("EMA_READY_FILE", str(ready_file))

    cleanup = publish_ready(43121)
    assert json.loads(ready_file.read_text(encoding="utf-8")) == {"port": 43121}
    assert cleanup is not None
    cleanup()
    assert not ready_file.exists()


def test_missing_ready_file_env_skips_publish(monkeypatch) -> None:
    monkeypatch.delenv("EMA_READY_FILE", raising=False)
    assert publish_ready(43121) is None
