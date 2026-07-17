# 提供 Narrative 路由、查询和内部语料维护接口。
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from bridge.state import state

router = APIRouter(prefix="/narrative")

_NOT_READY = HTTPException(
    status_code=503,
    detail="Narrative not ready. POST /internal/configure with llm + embed first.",
)


# ── /narrative/route ──────────────────────────────────────────────────────────

class RouteRequest(BaseModel):
    query: str = Field(..., min_length=1)


class RouteResponse(BaseModel):
    routes: dict[str, str] = Field(
        description="timeline → sub-query. TS should emit this as a narrative_route SSE event."
    )


@router.post("/route", response_model=RouteResponse)
async def route_narrative(body: RouteRequest) -> RouteResponse:
    """
    Route a user query to relevant timelines and rewrite sub-queries for RAG retrieval.
    TS receives the routes dict and emits it as a stage event so the frontend can display
    which timelines are being searched.
    """
    if state.narrative_router is None:
        raise _NOT_READY
    routes = await state.narrative_router.route(body.query)
    return RouteResponse(routes=routes)


# ── /narrative/query ──────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    queries: dict[str, str] = Field(
        ...,
        description="timeline → sub-query (as returned by /narrative/route).",
    )
    mode:   str = Field(default="hybrid")
    top_k:  int = Field(default=40, ge=1, le=200)


class QueryResponse(BaseModel):
    results: dict[str, str]


@router.post("/query", response_model=QueryResponse)
async def query_narrative(body: QueryRequest) -> QueryResponse:
    """
    Run LightRAG retrieval for each timeline sub-query in parallel.
    """
    if state.narrative_manager is None:
        raise _NOT_READY
    results = await state.narrative_manager.query_batch(body.queries, mode=body.mode, top_k=body.top_k)
    return QueryResponse(results=results)


# ── /narrative/ingest ─────────────────────────────────────────────────────────

VALID_TIMELINES = frozenset({"1st_Loop", "2nd_Loop", "3rd_Loop"})


class IngestRequest(BaseModel):
    timeline:  str       = Field(..., description="One of: 1st_Loop, 2nd_Loop, 3rd_Loop")
    documents: list[str] = Field(..., min_length=1, description="Raw text documents to ingest")


class IngestResponse(BaseModel):
    accepted: int


@router.post("/ingest", response_model=IngestResponse)
async def ingest_narrative(body: IngestRequest) -> IngestResponse:
    """
    为未来续作或同世界观资料重建，将离线清洗文本写入指定时间线。

    该接口是内部内容维护能力，不属于 V1 用户运行时流程，也不应直接暴露给前端。
    普通 Narrative Turn 只调用 route/query；查询产生的 LightRAG Cache 更新不是 ingest。
    LightRAG 按内容哈希去重，因此重新写入相同文本是安全的。
    """
    if state.narrative_manager is None:
        raise _NOT_READY
    if body.timeline not in VALID_TIMELINES:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid timeline '{body.timeline}'. Must be one of: {sorted(VALID_TIMELINES)}",
        )
    accepted = await state.narrative_manager.ingest(body.timeline, body.documents)
    return IngestResponse(accepted=accepted)
