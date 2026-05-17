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
        dim        = state.embedder.dim if state.embedder else 1024

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

    async def query_batch(
        self,
        queries: dict[str, str],
        mode: str = "hybrid",
    ) -> dict[str, str]:
        """Query multiple timelines in parallel. Unknown timelines are silently skipped."""
        valid = {t: q for t, q in queries.items() if t in self._instances}

        async def _one(timeline: str, query: str) -> tuple[str, str]:
            result = await self._instances[timeline].aquery(
                query,
                param=QueryParam(mode=mode),
            )
            return timeline, result or ""

        pairs = await asyncio.gather(*(_one(t, q) for t, q in valid.items()))
        return dict(pairs)
