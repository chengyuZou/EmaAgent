from fastapi import APIRouter, Header, HTTPException
import os

from bridge.config import ConfigureRequest
from bridge.narrative.manager import NarrativeManager
from bridge.narrative.router import NarrativeRouter
from bridge.state import state

router = APIRouter(prefix="/internal")

_SECRET        = os.environ.get("EMA_SHARED_SECRET", "")
_NARRATIVE_DIR = os.environ.get("EMA_NARRATIVE_DIR", "./data/narrative")


def _check_secret(x_ema_secret: str | None) -> None:
    if _SECRET and x_ema_secret != _SECRET:
        raise HTTPException(status_code=403, detail="forbidden")


@router.post("/configure", status_code=204)
async def configure(
    body: ConfigureRequest,
    x_ema_secret: str | None = Header(default=None),
) -> None:
    """
    Push LightRAG config from apps/core.
    Called on startup and whenever embed or lightrag-llm bindings change.
    """
    _check_secret(x_ema_secret)

    if body.embed is not None:
        state.embed_api_key  = body.embed.api_key
        state.embed_base_url = body.embed.base_url
        state.embed_model    = body.embed.model
        state.embed_dim      = body.embed.dim

    if body.llm is not None:
        state.llm_api_key  = body.llm.api_key
        state.llm_base_url = body.llm.base_url
        state.llm_model    = body.llm.model

    if state.embed_ready and state.llm_ready:
        manager = NarrativeManager(state, _NARRATIVE_DIR)
        await manager.initialize()
        state.narrative_manager = manager
        state.narrative_router  = NarrativeRouter(state)
