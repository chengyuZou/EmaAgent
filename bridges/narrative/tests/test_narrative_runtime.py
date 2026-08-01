# 测试配置 generation 原子切换、失败保留旧代与在途请求排空。
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from narrativeBridge.configuration import NarrativeProviderSnapshot
from narrativeBridge.narrativeRuntime import (
    NarrativeGeneration,
    NarrativeRuntime,
)


class Closable:
    def __init__(self) -> None:
        self.closed = asyncio.Event()

    async def close(self) -> None:
        self.closed.set()


class FakeService:
    pass


def snapshot(model: str) -> NarrativeProviderSnapshot:
    return NarrativeProviderSnapshot(
        embed_api_key="embed-key",
        embed_base_url="https://embed.test",
        embed_model=f"{model}-embed",
        embed_dim=1024,
        llm_api_key="llm-key",
        llm_base_url="https://llm.test",
        llm_model=model,
    )


def generation(name: str) -> NarrativeGeneration:
    return NarrativeGeneration(
        generation_id=name,
        clients=Closable(),
        store=Closable(),
        service=FakeService(),
    )


@pytest.mark.asyncio
async def test_failed_generation_keeps_current_generation(tmp_path: Path) -> None:
    calls = 0

    async def builder(config, root):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("initialize failed")
        return generation(config.llm_model)

    runtime = NarrativeRuntime(tmp_path, builder)
    await runtime.configure(snapshot("old"))
    with pytest.raises(RuntimeError, match="initialize failed"):
        await runtime.configure(snapshot("new"))
    assert runtime.generation_id == "old"
    await runtime.close()


@pytest.mark.asyncio
async def test_replaced_generation_waits_for_active_lease(tmp_path: Path) -> None:
    built: list[NarrativeGeneration] = []

    async def builder(config, root):
        result = generation(config.llm_model)
        built.append(result)
        return result

    runtime = NarrativeRuntime(tmp_path, builder)
    await runtime.configure(snapshot("old"))
    old = built[0]
    async with runtime.lease() as leased:
        assert leased is old
        await runtime.configure(snapshot("new"))
        await asyncio.sleep(0)
        assert not old.closed

    await asyncio.wait_for(old.store.closed.wait(), timeout=1)
    assert old.closed
    assert runtime.generation_id == "new"
    await runtime.close()


@pytest.mark.asyncio
async def test_clear_snapshot_stops_new_requests_and_closes_idle_generation(
    tmp_path: Path,
) -> None:
    current = generation("configured")

    async def builder(config, root):
        return current

    runtime = NarrativeRuntime(tmp_path, builder)
    await runtime.configure(snapshot("configured"))
    await runtime.configure(None)
    await asyncio.wait_for(current.store.closed.wait(), timeout=1)
    assert not runtime.ready
