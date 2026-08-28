# 一次不可分割的 Recall：周目路由 → 各时间线并行检索，只返回背景不生成回答。
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from .content import TIMELINES
from .light_rag import LightRagTimelines, TimelineQueryFailure
from .model_client import RecallLlmClient
from .prompt import ROUTER_PROMPT_TEMPLATE, STORY_SUMMARY

_JSON_PATTERN = re.compile(r"\{[\s\S]*\}", re.DOTALL)
_VALID_TIMELINES = frozenset(TIMELINES)


@dataclass(frozen=True, slots=True)
class NarrativeRecall:
    routes: dict[str, str]
    results: dict[str, str]
    failures: tuple[TimelineQueryFailure, ...]


async def route_loops(client: RecallLlmClient, query: str) -> dict[str, str]:
    """用当次 Recall 的 LLM 把用户问题拆分为涉及到的剧情时间线。"""
    normalized_query = query.strip()
    if not normalized_query:
        raise ValueError("query must not be empty")

    content = (
        await client.route_completion(
            ROUTER_PROMPT_TEMPLATE.format(summary=STORY_SUMMARY),
            normalized_query,
        )
    ).strip()

    try:
        result = json.loads(content)
    except json.JSONDecodeError:
        match = _JSON_PATTERN.search(content)
        if match is None:
            raise ValueError("Narrative 路由模型没有返回 JSON 对象")
        result = json.loads(match.group())

    if not isinstance(result, dict):
        raise ValueError("Narrative 路由模型返回值不是对象")
    invalid = set(result) - _VALID_TIMELINES
    if invalid:
        raise ValueError(f"Narrative 路由包含未知时间线: {sorted(invalid)}")

    routes = {
        timeline: sub_query.strip()
        for timeline, sub_query in result.items()
        if isinstance(sub_query, str) and sub_query.strip()
    }
    if not routes:
        raise ValueError("Narrative 路由没有生成可执行的子问题")
    return routes


async def recall(
    store: LightRagTimelines,
    client: RecallLlmClient,
    query: str,
    *,
    mode: str,
    top_k: int,
) -> NarrativeRecall:
    routes = await route_loops(client, query)
    batch = await store.query_batch(
        routes,
        mode=mode,
        top_k=top_k,
        model_func=client.complete_for_lightrag,
    )
    return NarrativeRecall(
        routes=routes,
        results=batch.results,
        failures=batch.failures,
    )
