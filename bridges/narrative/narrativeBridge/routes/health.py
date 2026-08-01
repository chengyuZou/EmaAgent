# 暴露不含用户数据的进程与 Narrative 就绪状态。
from fastapi import APIRouter, Request

from .runtimeAccess import require_runtime

router = APIRouter()


@router.get("/health")
async def health(request: Request) -> dict:
    try:
        runtime = require_runtime(request)
    except Exception:
        return {
            "status": "starting",
            "version": "0.1.0",
            "capabilities": {"embed": False, "llm": False, "narrative": False},
        }
    ready = runtime.ready
    return {
        "status": "ok",
        "version": "0.1.0",
        "capabilities": {
            "embed": ready,
            "llm": ready,
            "narrative": ready,
        },
    }
