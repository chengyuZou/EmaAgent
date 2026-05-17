from fastapi import APIRouter, Header, HTTPException
import os

from bridge.config import ConfigureRequest
from bridge.embed import CohereStyleReranker, OpenAICompatEmbedder
from bridge.narrative.manager import NarrativeManager
from bridge.narrative.router import NarrativeRouter
from bridge.state import state

router = APIRouter(prefix="/internal")

_SECRET = os.environ.get("EMA_SHARED_SECRET", "")
_NARRATIVE_DIR = os.environ.get("EMA_NARRATIVE_DIR", "./data/narrative")


def _check_secret(x_ema_secret: str | None) -> None:
    """Reject requests that don't carry the shared secret (when set)."""
    if _SECRET and x_ema_secret != _SECRET:
        raise HTTPException(status_code=403, detail="forbidden")


@router.post("/configure", status_code=204)
async def configure(
    body: ConfigureRequest,
    x_ema_secret: str | None = Header(default=None),
) -> None:
    """
    Configure bridge providers. Called by apps/core on startup and whenever
    provider settings change in the UI. Each section is optional — only
    provided sections are updated.
    """
    _check_secret(x_ema_secret)

    if body.embed is not None:
        # Pydantic Literal["openai-embed"] guarantees protocol is valid here.
        state.embedder = OpenAICompatEmbedder(
            model=body.embed.model,
            api_key=body.embed.api_key,
            base_url=body.embed.base_url,
            dim=body.embed.dim,
        )

    if body.rerank is not None:
        state.reranker = CohereStyleReranker(
            model=body.rerank.model,
            api_key=body.rerank.api_key,
            base_url=body.rerank.base_url,
        )

    if body.llm is not None:
        state.llm_api_key  = body.llm.api_key
        state.llm_base_url = body.llm.base_url
        state.llm_model    = body.llm.model

    # Rebuild narrative components whenever embed or llm config changes and both are ready.
    if state.embed_ready and state.llm_ready:
        state.narrative_manager = NarrativeManager(state, _NARRATIVE_DIR)
        state.narrative_router  = NarrativeRouter(state)
