# 接收 LocalHost 的完整模型配置，并原子发布新的 Narrative generation。
from fastapi import APIRouter, Request

from ..configuration import ConfigureRequest, NarrativeProviderSnapshot
from .runtimeAccess import require_runtime

router = APIRouter(prefix="/internal")


@router.post("/configure", status_code=204)
async def configure(body: ConfigureRequest, request: Request) -> None:
    runtime = require_runtime(request)
    await runtime.configure(NarrativeProviderSnapshot.from_request(body))
