# 解析并验证宿主显式提供的全局剧情数据目录。
from __future__ import annotations

import os
import tempfile
from collections.abc import Mapping
from pathlib import Path

from ..errors import NarrativeContentError

TIMELINES = ("1st_Loop", "2nd_Loop", "3rd_Loop")


def resolve_narrative_root(environ: Mapping[str, str] | None = None) -> Path:
    env = os.environ if environ is None else environ
    configured = env.get("EMA_NARRATIVE_DIR", "").strip()
    if not configured:
        raise NarrativeContentError(
            "EMA_NARRATIVE_DIR 未配置；剧情数据由桌面宿主安装并显式传入"
        )

    candidate = Path(configured).expanduser()
    if not candidate.is_absolute():
        raise NarrativeContentError(
            "EMA_NARRATIVE_DIR 必须是绝对路径，不能依赖进程当前工作目录"
        )
    return candidate.resolve(strict=False)


def validate_narrative_root(root: Path) -> None:
    """拒绝静默创建空世界，并确认 LightRAG 的查询缓存能够写回。"""
    if not root.is_dir():
        raise NarrativeContentError(f"Narrative 剧情目录不存在或不是目录: {root}")

    missing = [timeline for timeline in TIMELINES if not (root / timeline).is_dir()]
    if missing:
        raise NarrativeContentError(
            f"Narrative 剧情目录缺少时间线 {', '.join(missing)}: {root}"
        )

    for timeline in TIMELINES:
        timeline_dir = root / timeline
        try:
            with tempfile.NamedTemporaryFile(
                dir=timeline_dir,
                prefix=".ema-write-probe-",
                delete=True,
            ):
                pass
        except OSError as error:
            raise NarrativeContentError(
                f"Narrative 时间线目录不可写: {timeline_dir}"
            ) from error
