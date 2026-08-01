# 管理三条时间线的 LightRAG 存储，并只返回检索上下文而不生成最终回答。
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

from lightrag import LightRAG, QueryParam
from lightrag.utils import EmbeddingFunc

from ..configuration import NarrativeProviderSnapshot
from .contentPaths import TIMELINES
from .modelClients import NarrativeModelClients


@dataclass(frozen=True, slots=True)
class TimelineQueryFailure:
    timeline: str
    code: str
    message: str
    retryable: bool


@dataclass(frozen=True, slots=True)
class TimelineQueryBatch:
    results: dict[str, str]
    failures: tuple[TimelineQueryFailure, ...]


class LightRagTimelineStore:
    def __init__(
        self,
        root: Path,
        snapshot: NarrativeProviderSnapshot,
        clients: NarrativeModelClients,
    ) -> None:
        self.instances = {
            timeline: LightRAG(
                working_dir=str(root / timeline),
                llm_model_func=clients.complete_for_lightrag,
                embedding_func=EmbeddingFunc(
                    embedding_dim=snapshot.embed_dim,
                    max_token_size=8192,
                    func=clients.embed_texts,
                ),
            )
            for timeline in TIMELINES
        }

    async def initialize(self) -> None:
        initialized: list[LightRAG] = []
        try:
            for rag in self.instances.values():
                await rag.initialize_storages()
                initialized.append(rag)
        except BaseException:
            for rag in reversed(initialized):
                try:
                    await rag.finalize_storages()
                except Exception:
                    pass
            raise

    async def query_batch(
        self,
        queries: dict[str, str],
        mode: str,
        top_k: int,
    ) -> TimelineQueryBatch:
        valid_queries = {
            timeline: query
            for timeline, query in queries.items()
            if timeline in self.instances and query.strip()
        }

        async def query_one(timeline: str, query: str) -> tuple[str, str]:
            result = await self.instances[timeline].aquery(
                query,
                param=QueryParam(mode=mode, only_need_context=True, top_k=top_k),
            )
            return timeline, result or ""

        settled = await asyncio.gather(
            *(query_one(timeline, query) for timeline, query in valid_queries.items()),
            return_exceptions=True,
        )
        results: dict[str, str] = {}
        failures: list[TimelineQueryFailure] = []
        for timeline, item in zip(valid_queries, settled, strict=True):
            if isinstance(item, BaseException):
                failures.append(
                    TimelineQueryFailure(
                        timeline=timeline,
                        code="timeline_query_failed",
                        message=str(item),
                        retryable=True,
                    )
                )
                continue
            result_timeline, text = item
            results[result_timeline] = text

        if failures and not results:
            raise RuntimeError(failures[0].message)
        return TimelineQueryBatch(results=results, failures=tuple(failures))

    async def close(self) -> None:
        for rag in self.instances.values():
            try:
                await rag.finalize_storages()
            except Exception:
                # 关闭是尽力而为；不能让一条时间线阻止其他句柄释放。
                pass
