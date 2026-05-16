from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from bridge.state import state

router = APIRouter()


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1)


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    dim: int


@router.post("/embed", response_model=EmbedResponse)
async def embed(body: EmbedRequest) -> EmbedResponse:
    if not state.embed_ready:
        raise HTTPException(
            status_code=503,
            detail="Embed provider not configured. POST /internal/configure first.",
        )

    valid = [t for t in body.texts if t and t.strip()]
    if not valid:
        raise HTTPException(status_code=422, detail="All texts are empty")

    vectors = await state.embedder.embed(valid)  # type: ignore[union-attr]
    return EmbedResponse(
        embeddings=vectors.tolist(),
        dim=state.embedder.dim,  # type: ignore[union-attr]
    )
