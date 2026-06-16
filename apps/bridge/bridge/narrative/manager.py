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

# How long finalize() waits for in-flight requests to drain before giving up
# and closing storage handles anyway (best-effort — matches this codebase's
# pattern of bounded waits over indefinite blocking, e.g. TtsCoordinator's
# abort/finish race).
_DRAIN_TIMEOUT_S = 30.0


class NarrativeManager:
    """
    Owns one LightRAG instance per timeline (1st/2nd/3rd Loop).
    Constructed synchronously; storage is lazily initialised by LightRAG on first use.

    `/internal/configure` builds a fresh instance on every reconfigure and
    replaces `state.narrative_manager`, then calls `finalize()` on the old
    one. Once replaced, nothing reachable from `state` can start a NEW
    request against this instance — but a request that started just before
    the swap may still be mid-flight. `_active`/`_drained` let `finalize()`
    wait for those to finish instead of closing storage out from under them.
    """

    def __init__(self, state: BridgeState, data_dir: str) -> None:
        embed_func = make_embedding_func(state)
        llm_func   = make_llm_func(state)
        dim        = state.embed_dim

        self._active  = 0
        self._drained = asyncio.Event()
        self._drained.set()  # starts idle — zero in-flight requests

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

    def _enter(self) -> None:
        self._active += 1
        self._drained.clear()

    def _exit(self) -> None:
        self._active = max(0, self._active - 1)
        if self._active == 0:
            self._drained.set()

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

        self._enter()
        try:
            settled = await asyncio.gather(
                *(_one(t, q) for t, q in valid.items()),
                return_exceptions=True,
            )
        finally:
            self._exit()
        results: dict[str, str] = {}
        errors: list[BaseException] = []
        for item in settled:
            if isinstance(item, BaseException):
                errors.append(item)
                continue
            timeline, text = item
            results[timeline] = text

        # If every timeline failed, surface the first error so the caller gets
        # a 500 (and TS can emit system_warning) rather than a silent empty result.
        if errors and not results:
            raise errors[0]

        return results

    async def ingest(self, timeline: str, documents: list[str]) -> int:
        """Insert documents into a single timeline's LightRAG graph.

        Returns the number of documents accepted (0 if timeline unknown).
        LightRAG deduplicates by content hash, so re-ingesting is safe.
        """
        rag = self._instances.get(timeline)
        if rag is None:
            return 0
        self._enter()
        try:
            await rag.ainsert(documents)
        finally:
            self._exit()
        return len(documents)

    async def finalize(self) -> None:
        """
        Release LightRAG storage handles. Called on bridge shutdown, and by
        `/internal/configure` on the manager being replaced.

        Waits (bounded by _DRAIN_TIMEOUT_S) for any in-flight query_batch/ingest
        call to finish before closing storage — otherwise a request that
        started just before a reconfigure could have its storage handle
        closed mid-read. Best-effort: a request stuck past the timeout
        doesn't block finalize forever, matching this codebase's other
        bounded-wait shutdown paths.
        """
        if self._active > 0:
            try:
                await asyncio.wait_for(self._drained.wait(), timeout=_DRAIN_TIMEOUT_S)
            except asyncio.TimeoutError:
                pass  # proceed anyway — closing late is better than leaking forever
        for timeline, rag in self._instances.items():
            try:
                await rag.finalize_storages()
            except Exception as exc:  # noqa: BLE001
                pass  # best-effort; don't block shutdown
