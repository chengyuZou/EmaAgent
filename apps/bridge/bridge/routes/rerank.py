from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from bridge.state import state

router = APIRouter()


class RerankRequest(BaseModel):
    query: str = Field(..., min_length=1)
    documents: list[str] = Field(..., min_length=1)
    top_k: int = Field(default=5, ge=1, le=100)


class RerankItem(BaseModel):
    index: int
    score: float


class RerankResponse(BaseModel):
    results: list[RerankItem]


@router.post("/rerank", response_model=RerankResponse)
async def rerank(body: RerankRequest) -> RerankResponse:
    if not state.rerank_ready:
        raise HTTPException(
            status_code=503,
            detail="Rerank provider not configured. POST /internal/configure first.",
        )

    results = await state.reranker.rerank(  # type: ignore[union-attr]
        query=body.query,
        docs=body.documents,
        top_k=body.top_k,
    )
    return RerankResponse(
        results=[RerankItem(index=r.index, score=r.score) for r in results]
    )
