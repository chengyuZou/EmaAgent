# 将剧情路由与多时间线检索合成一次不可分割的 Recall 操作。
from __future__ import annotations

from dataclasses import dataclass

from .lightRagStore import LightRagTimelineStore, TimelineQueryFailure
from .narrativeRouter import NarrativeRouter


@dataclass(frozen=True, slots=True)
class NarrativeRecall:
    routes: dict[str, str]
    results: dict[str, str]
    failures: tuple[TimelineQueryFailure, ...]


class NarrativeService:
    def __init__(
        self,
        router: NarrativeRouter,
        store: LightRagTimelineStore,
    ) -> None:
        self.router = router
        self.store = store

    async def recall(
        self,
        query: str,
        mode: str = "hybrid",
        top_k: int = 40,
    ) -> NarrativeRecall:
        routes = await self.router.route(query)
        batch = await self.store.query_batch(routes, mode=mode, top_k=top_k)
        return NarrativeRecall(
            routes=routes,
            results=batch.results,
            failures=batch.failures,
        )
