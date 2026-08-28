# 测试剧情目录必须由宿主显式传入且三条时间线完整。
from __future__ import annotations

from pathlib import Path

import pytest

from core.content import (
    TIMELINES,
    NarrativeContentError,
    resolve_narrative_root,
    validate_narrative_root,
)


def test_missing_root_env_is_rejected(monkeypatch) -> None:
    monkeypatch.delenv("EMA_NARRATIVE_DIR", raising=False)
    with pytest.raises(NarrativeContentError, match="未配置"):
        resolve_narrative_root()


def test_explicit_root_is_accepted(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("EMA_NARRATIVE_DIR", str(tmp_path))
    root = resolve_narrative_root()
    assert root == tmp_path


def test_missing_timeline_does_not_create_empty_world(tmp_path: Path) -> None:
    for timeline in TIMELINES[:-1]:
        (tmp_path / timeline).mkdir()
    with pytest.raises(NarrativeContentError, match=TIMELINES[-1]):
        validate_narrative_root(tmp_path)
    assert not (tmp_path / TIMELINES[-1]).exists()
