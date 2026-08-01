# 从 FastAPI 应用状态取得唯一 Narrative Runtime。
from fastapi import Request

from ..errors import NarrativeNotConfiguredError
from ..narrativeRuntime import NarrativeRuntime


def require_runtime(request: Request) -> NarrativeRuntime:
    runtime = getattr(request.app.state, "narrative_runtime", None)
    if not isinstance(runtime, NarrativeRuntime):
        raise NarrativeNotConfiguredError("Narrative Runtime 尚未完成启动")
    return runtime
