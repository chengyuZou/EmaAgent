from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING

from lightrag import LightRAG, QueryParam
from lightrag.utils import EmbeddingFunc

from bridge.narrative.adapters import make_embedding_func, make_llm_func

if TYPE_CHECKING:
    from bridge.state import BridgeState

TIMELINES = ("1st_Loop", "2nd_Loop", "3rd_Loop")


class NarrativeManager:
    """
    Owns one LightRAG instance per timeline (1st/2nd/3rd Loop).
    Constructed synchronously; storage is lazily initialised by LightRAG on first use.
    """

    def __init__(self, state: BridgeState, data_dir: str) -> None:
        embed_func = make_embedding_func(state)
        llm_func   = make_llm_func(state)
        dim        = state.embed_dim

        self._instances: dict[str, LightRAG] = {}
        for timeline in TIMELINES:
            working_dir = Path(data_dir) / timeline
            working_dir.mkdir(parents=True, exist_ok=True)
            self._instances[timeline] = LightRAG(
                working_dir=str(working_dir),
                llm_model_func=llm_func,
                embedding_func=EmbeddingFunc(
                    embedding_dim=dim,
                    max_token_size=8192,
                    func=embed_func,
                ),
            )

    async def initialize(self) -> None:
        """Must be called once before any query — required by lightrag-hku >=1.4."""
        for rag in self._instances.values():
            await rag.initialize_storages()

    async def query_batch(
        self,
        queries: dict[str, str],
        mode: str = "hybrid",
        top_k: int = 40,
    ) -> dict[str, str]:
        """Query multiple timelines in parallel. Unknown timelines are silently skipped.

        only_need_context=True: LightRAG returns raw retrieved context without
        calling the LLM for a synthesised answer — the main ConversationEngine
        LLM does that instead.
        """
        valid = {t: q for t, q in queries.items() if t in self._instances}

        async def _one(timeline: str, query: str) -> tuple[str, str]:
            result = await self._instances[timeline].aquery(
                query,
                param=QueryParam(mode=mode, only_need_context=True, top_k=top_k),
            )
            return timeline, result or ""

        pairs = await asyncio.gather(*(_one(t, q) for t, q in valid.items()))
        return dict(pairs)

    async def finalize(self) -> None:
        """Release LightRAG storage handles. Call on bridge shutdown."""
        for timeline, rag in self._instances.items():
            try:
                await rag.finalize_storages()
            except Exception as exc:  # noqa: BLE001
                pass  # best-effort; don't block shutdown
