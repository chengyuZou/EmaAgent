from fastapi import APIRouter
from bridge.state import state

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "version": "0.1.0",
        "capabilities": {
            "embed":   state.embed_ready,
            "rerank":  state.rerank_ready,
            "llm":     state.llm_ready,
        },
    }
