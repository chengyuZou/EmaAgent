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
    mode: str = Field(default="hybrid")


class QueryResponse(BaseModel):
    results: dict[str, str]


@router.post("/query", response_model=QueryResponse)
async def query_narrative(body: QueryRequest) -> QueryResponse:
    """
    Run LightRAG retrieval for each timeline sub-query in parallel.
    """
    if state.narrative_manager is None:
        raise _NOT_READY
    results = await state.narrative_manager.query_batch(body.queries, mode=body.mode)
    return QueryResponse(results=results)
