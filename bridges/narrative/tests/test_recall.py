# 测试周目路由的 JSON 健壮性与 Recall 的路由→并行检索合成。
from __future__ import annotations

import pytest

from core.light_rag import TimelineQueryBatch, TimelineQueryFailure, _llm_without_connection
from core.recall import recall, route_loops


class FakeLlmClient:
    def __init__(self, route_response: str) -> None:
        self.route_response = route_response
        self.route_calls: list[str] = []

    async def route_completion(self, system_prompt: str, query: str) -> str:
        self.route_calls.append(query)
        return self.route_response

    async def complete_for_lightrag(self, prompt: str, **kwargs) -> str:
        return "lightrag-answer"


class FakeTimelines:
    def __init__(self, batch: TimelineQueryBatch) -> None:
        self.batch = batch
        self.received: dict | None = None
        self.model_func_used = None

    async def query_batch(self, queries, *, mode, top_k, model_func):
        self.received = {"queries": queries, "mode": mode, "top_k": top_k}
        self.model_func_used = model_func
        return self.batch


@pytest.mark.asyncio
async def test_route_parses_clean_json() -> None:
    client = FakeLlmClient('{"2nd_Loop": "希罗为何疏远艾玛？"}')
    routes = await route_loops(client, "希罗为什么在第二周目疏远艾玛")
    assert routes == {"2nd_Loop": "希罗为何疏远艾玛？"}


@pytest.mark.asyncio
async def test_route_recovers_json_from_prose() -> None:
    client = FakeLlmClient('答案是：{"1st_Loop": "子问题"} 以上。')
    routes = await route_loops(client, "第一周目谁杀了诺亚")
    assert routes == {"1st_Loop": "子问题"}


@pytest.mark.asyncio
async def test_route_rejects_non_json_and_unknown_timeline() -> None:
    with pytest.raises(ValueError, match="JSON"):
        await route_loops(FakeLlmClient("不是 JSON"), "问题")
    with pytest.raises(ValueError, match="未知时间线"):
        await route_loops(FakeLlmClient('{"4th_Loop": "x"}'), "问题")


@pytest.mark.asyncio
async def test_route_rejects_empty_routes() -> None:
    with pytest.raises(ValueError, match="子问题"):
        await route_loops(FakeLlmClient('{"1st_Loop": "  "}'), "问题")


@pytest.mark.asyncio
async def test_recall_composes_route_and_parallel_query() -> None:
    failure = TimelineQueryFailure(
        timeline="3rd_Loop",
        code="timeline_query_failed",
        message="boom",
    )
    store = FakeTimelines(TimelineQueryBatch(results={"1st_Loop": "背景文本"}, failures=(failure,)))
    client = FakeLlmClient('{"1st_Loop": "诺亚之死", "3rd_Loop": "真结局"}')

    result = await recall(store, client, "诺亚怎么死的", mode="hybrid", top_k=40)

    assert store.received == {
        "queries": {"1st_Loop": "诺亚之死", "3rd_Loop": "真结局"},
        "mode": "hybrid",
        "top_k": 40,
    }
    assert store.model_func_used == client.complete_for_lightrag
    assert result.routes == {"1st_Loop": "诺亚之死", "3rd_Loop": "真结局"}
    assert result.results == {"1st_Loop": "背景文本"}
    assert result.failures == (failure,)


@pytest.mark.asyncio
async def test_llm_placeholder_fails_loudly() -> None:
    with pytest.raises(RuntimeError, match="model_func"):
        await _llm_without_connection()
