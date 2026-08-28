# 解析并验证宿主显式提供的全局剧情数据目录。
from __future__ import annotations

import os
from pathlib import Path

TIMELINES = ("1st_Loop", "2nd_Loop", "3rd_Loop")


class NarrativeContentError(RuntimeError):
    """Narrative 剧情目录缺失或结构错误。"""


def resolve_narrative_root() -> Path:
    configured = os.environ.get("EMA_NARRATIVE_DIR", "").strip()
    if not configured:
        raise NarrativeContentError(
            "EMA_NARRATIVE_DIR 未配置；剧情数据由桌面宿主安装并显式传入"
        )
    return Path(configured)


def validate_narrative_root(root: Path) -> None:
    """目录必须由宿主安装完整；缺时间线时拒绝启动，避免 LightRAG 静默创建空世界。"""
    if not root.is_dir():
        raise NarrativeContentError(f"Narrative 剧情目录不存在或不是目录: {root}")

    missing = [timeline for timeline in TIMELINES if not (root / timeline).is_dir()]
    if missing:
        raise NarrativeContentError(
            f"Narrative 剧情目录缺少时间线 {', '.join(missing)}: {root}"
        )
