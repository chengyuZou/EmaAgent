# 提供原子 Recall 主入口，并暂时兼容旧 route/query 两段式调用。
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from .runtimeAccess import require_runtime

router = APIRouter(prefix="/narrative")
QueryMode = Literal["local", "global", "hybrid", "naive", "mix"]


class RouteRequest(BaseModel):
    query: str = Field(..., min_length=1)


class RouteResponse(BaseModel):
    routes: dict[str, str]


class QueryRequest(BaseModel):
    queries: dict[str, str]
    mode: QueryMode = "hybrid"
    top_k: int = Field(default=40, ge=1, le=200)


class QueryFailureResponse(BaseModel):
    timeline: str
    code: str
    message: str
    retryable: bool


class QueryResponse(BaseModel):
    results: dict[str, str]
    failures: list[QueryFailureResponse] = Field(default_factory=list)


class RecallRequest(BaseModel):
    query: str = Field(..., min_length=1)
    mode: QueryMode = "hybrid"
    top_k: int = Field(default=40, ge=1, le=200)


class RecallResponse(BaseModel):
    generation_id: str = Field(serialization_alias="generationId")
    routes: dict[str, str]
    results: dict[str, str]
    failures: list[QueryFailureResponse]


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
                QueryFailureResponse(
                    timeline=failure.timeline,
                    code=failure.code,
                    message=failure.message,
                    retryable=failure.retryable,
                )
                for failure in recalled.failures
            ],
        )


@router.post("/route", response_model=RouteResponse, deprecated=True)
async def route_narrative(body: RouteRequest, request: Request) -> RouteResponse:
    runtime = require_runtime(request)
    async with runtime.lease() as generation:
        return RouteResponse(routes=await generation.service.route(body.query))


@router.post("/query", response_model=QueryResponse, deprecated=True)
async def query_narrative(body: QueryRequest, request: Request) -> QueryResponse:
    runtime = require_runtime(request)
    async with runtime.lease() as generation:
        batch = await generation.service.query(
            body.queries,
            mode=body.mode,
            top_k=body.top_k,
        )
        return QueryResponse(
            results=batch.results,
            failures=[
                QueryFailureResponse(
                    timeline=failure.timeline,
                    code=failure.code,
                    message=failure.message,
                    retryable=failure.retryable,
                )
                for failure in batch.failures
            ],
        )
