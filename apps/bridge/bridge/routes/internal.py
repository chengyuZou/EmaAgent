import asyncio
import os

from fastapi import APIRouter

from bridge.config import ConfigureRequest
from bridge.narrative.manager import NarrativeManager
from bridge.narrative.router import NarrativeRouter
from bridge.state import BridgeState, state

router = APIRouter(prefix="/internal")

_NARRATIVE_DIR = os.environ.get("EMA_NARRATIVE_DIR", "./data/narrative")

# Serializes /internal/configure — without this, two overlapping requests
# (e.g. a settings-page save racing the bridge heartbeat's retry) would each
# build their own NarrativeManager and load the same on-disk LightRAG storage
# concurrently. Module-level singleton is fine: one bridge process, one lock.
_configure_lock = asyncio.Lock()


@router.post("/configure", status_code=204)
async def configure(
    body: ConfigureRequest,
) -> None:
    """
    Push LightRAG config from apps/core.
    Called on startup and whenever embed or lightrag-llm bindings change.
    """
    async with _configure_lock:
        # 先在隔离快照中构造下一代运行时；初始化失败时不污染当前 generation。
        next_state = BridgeState()
        if body.embed is not None:
            next_state.embed_api_key  = body.embed.api_key
            next_state.embed_base_url = body.embed.base_url
            next_state.embed_model    = body.embed.model
            next_state.embed_dim      = body.embed.dim

        if body.llm is not None:
            next_state.llm_api_key  = body.llm.api_key
            next_state.llm_base_url = body.llm.base_url
            next_state.llm_model    = body.llm.model

        old_manager = state.narrative_manager
        if next_state.embed_ready and next_state.llm_ready:
            manager = NarrativeManager(next_state, _NARRATIVE_DIR)
            await manager.initialize()
            router = NarrativeRouter(next_state)

            # 新 generation 完整就绪后再一次性发布；之后的新请求不会再进入旧代。
            state.embed_api_key  = next_state.embed_api_key
            state.embed_base_url = next_state.embed_base_url
            state.embed_model    = next_state.embed_model
            state.embed_dim      = next_state.embed_dim
            state.llm_api_key    = next_state.llm_api_key
            state.llm_base_url   = next_state.llm_base_url
            state.llm_model      = next_state.llm_model
            state.narrative_manager = manager
            state.narrative_router  = router
        else:
            # 任一必要能力被撤销后立即停止接受新 Narrative 请求，并等待旧请求
            # 排空后释放存储句柄，同时显式清除原始密钥。
            state.embed_api_key = ""
            state.embed_base_url = ""
            state.embed_model = ""
            state.embed_dim = 1024
            state.llm_api_key = ""
            state.llm_base_url = ""
            state.llm_model = ""
            state.narrative_manager = None
            state.narrative_router = None

        # 旧代不再接收新请求；finalize 会有界等待已开始的请求排空。
        if old_manager is not None:
            await old_manager.finalize()
