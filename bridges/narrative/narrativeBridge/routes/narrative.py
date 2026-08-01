# 提供同一运行代际内完成路由与多时间线检索的原子 Recall 入口。
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from .runtimeAccess import require_runtime

router = APIRouter(prefix="/narrative")
QueryMode = Literal["local", "global", "hybrid", "naive", "mix"]


class TimelineFailureResponse(BaseModel):
    timeline: str
    code: Literal["timeline_query_failed"]
    message: str
    retryable: bool


class RecallRequest(BaseModel):
    query: str = Field(..., min_length=1)
    mode: QueryMode = "hybrid"
    top_k: int = Field(default=40, ge=1, le=200, validation_alias="topK")


class RecallResponse(BaseModel):
    generation_id: str = Field(serialization_alias="generationId")
    routes: dict[str, str]
    results: dict[str, str]
    failures: list[TimelineFailureResponse]


@router.post("/recall", response_model=RecallResponse)
async def recall_narrative(body: RecallRequest, request: Request) -> RecallResponse:
    runtime = require_runtime(request)
    async with runtime.lease() as generation:
        recalled = await generation.service.recall(
            body.query,
            mode=body.mode,
            top_k=body.top_k,
        )
        return RecallResponse(
            generation_id=generation.id,
            routes=recalled.routes,
            results=recalled.results,
            failures=[
                TimelineFailureResponse(
                    timeline=failure.timeline,
                    code=failure.code,
                    message=failure.message,
                    retryable=failure.retryable,
                )
                for failure in recalled.failures
            ],
        )
