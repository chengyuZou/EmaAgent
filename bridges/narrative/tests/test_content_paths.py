# 测试剧情目录必须由宿主显式传入且三条时间线完整可写。
from __future__ import annotations

from pathlib import Path

import pytest

from narrativeBridge.errors import NarrativeContentError
from narrativeBridge.retrieval.contentPaths import (
    TIMELINES,
    resolve_narrative_root,
    validate_narrative_root,
)


def test_missing_or_relative_root_is_rejected() -> None:
    with pytest.raises(NarrativeContentError, match="未配置"):
        resolve_narrative_root({})
    with pytest.raises(NarrativeContentError, match="绝对路径"):
        resolve_narrative_root({"EMA_NARRATIVE_DIR": "./data/narrative"})


def test_explicit_complete_root_is_accepted(tmp_path: Path) -> None:
    for timeline in TIMELINES:
        (tmp_path / timeline).mkdir()
    root = resolve_narrative_root({"EMA_NARRATIVE_DIR": str(tmp_path)})
    validate_narrative_root(root)
    assert root == tmp_path.resolve()
    assert all(list((root / timeline).iterdir()) == [] for timeline in TIMELINES)


def test_missing_timeline_does_not_create_empty_world(tmp_path: Path) -> None:
    for timeline in TIMELINES[:-1]:
        (tmp_path / timeline).mkdir()
    with pytest.raises(NarrativeContentError, match=TIMELINES[-1]):
        validate_narrative_root(tmp_path)
    assert not (tmp_path / TIMELINES[-1]).exists()
