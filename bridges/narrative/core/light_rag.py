# 三条时间线的 LightRAG 实例：启动时打开，按 Recall 注入当次 LLM 连接，进程退出时关闭。
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from lightrag import LightRAG, QueryParam
from lightrag.utils import EmbeddingFunc

from .content import TIMELINES

LightRagModelFunc = Callable[..., Awaitable[str]]


@dataclass(frozen=True, slots=True)
class TimelineQueryFailure:
    timeline: str
    code: str
    message: str


@dataclass(frozen=True, slots=True)
class TimelineQueryBatch:
    results: dict[str, str]
    failures: tuple[TimelineQueryFailure, ...]


async def _llm_without_connection(*args, **kwargs) -> str:
    """构造期占位：每次查询必须经 QueryParam.model_func 注入当次 Recall 的连接。"""
    raise RuntimeError("LightRAG 查询缺少 per-query model_func")


class LightRagTimelines:
    def __init__(self, root: Path, embedding_func: EmbeddingFunc) -> None:
        self.instances = {
            timeline: LightRAG(
                working_dir=str(root / timeline),
                llm_model_func=_llm_without_connection,
                embedding_func=embedding_func,
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
        *,
        mode: str,
        top_k: int,
        model_func: LightRagModelFunc,
    ) -> TimelineQueryBatch:
        valid_queries = {
            timeline: query
            for timeline, query in queries.items()
            if timeline in self.instances and query.strip()
        }

        async def query_one(timeline: str, query: str) -> tuple[str, str]:
            result = await self.instances[timeline].aquery(
                query,
                param=QueryParam(
                    mode=mode,
                    only_need_context=True,
                    top_k=top_k,
                    model_func=model_func,
                ),
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
