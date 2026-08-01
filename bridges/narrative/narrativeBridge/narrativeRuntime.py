"""
旧请求继续使用旧模型和旧 LightRAG 实例直到完成；新请求使用新配置。
旧资源等在途请求归零后再安全关闭，避免中途换模型导致请求报错、客户端被提前释放或结果混用。
"""

from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator, Awaitable, Callable

from .configuration import NarrativeProviderSnapshot
from .errors import NarrativeNotConfiguredError
from .retrieval.lightRagStore import LightRagTimelineStore
from .retrieval.modelClients import NarrativeModelClients
from .retrieval.narrativeRouter import NarrativeRouter
from .retrieval.narrativeService import NarrativeService


class NarrativeGeneration:
    def __init__(
        self,
        generation_id: str,
        clients: NarrativeModelClients,
        store: LightRagTimelineStore,
        service: NarrativeService,
    ) -> None:
        self.id = generation_id
        self.clients = clients
        self.store = store
        self.service = service
        self.active_requests = 0
        self.accepting_requests = True
        self.drained = asyncio.Event()
        self.drained.set()
        self.closed = False

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        await self.store.close()
        await self.clients.close()


GenerationBuilder = Callable[
    [NarrativeProviderSnapshot, Path], Awaitable[NarrativeGeneration]
]


async def build_generation(
    snapshot: NarrativeProviderSnapshot,
    narrative_root: Path,
) -> NarrativeGeneration:
    clients = NarrativeModelClients(snapshot)
    store = LightRagTimelineStore(narrative_root, snapshot, clients)
    try:
        await store.initialize()
    except BaseException:
        await clients.close()
        raise
    router = NarrativeRouter(clients)
    return NarrativeGeneration(
        generation_id=uuid.uuid4().hex,
        clients=clients,
        store=store,
        service=NarrativeService(router, store),
    )


class NarrativeRuntime:
    """新请求只进入当前代；被替换的代等已有请求自然结束后释放。"""

    def __init__(
        self,
        narrative_root: Path,
        builder: GenerationBuilder = build_generation,
    ) -> None:
        self._root = narrative_root
        self._builder = builder
        self._configure_lock = asyncio.Lock()
        self._state_lock = asyncio.Lock()
        self._current: NarrativeGeneration | None = None
        self._retiring: set[asyncio.Task[None]] = set()

    @property
    def ready(self) -> bool:
        return self._current is not None

    @property
    def generation_id(self) -> str | None:
        current = self._current
        return current.id if current is not None else None

    async def configure(self, snapshot: NarrativeProviderSnapshot | None) -> None:
        async with self._configure_lock:
            next_generation = (
                await self._builder(snapshot, self._root)
                if snapshot is not None
                else None
            )
            async with self._state_lock:
                previous = self._current
                self._current = next_generation
                if previous is not None:
                    previous.accepting_requests = False
            if previous is not None:
                self._retire(previous)

    @asynccontextmanager
    async def lease(self) -> AsyncIterator[NarrativeGeneration]:
        async with self._state_lock:
            generation = self._current
            if generation is None or not generation.accepting_requests:
                raise NarrativeNotConfiguredError("Narrative 尚未配置完整模型能力")
            generation.active_requests += 1
            generation.drained.clear()
        try:
            yield generation
        finally:
            async with self._state_lock:
                generation.active_requests -= 1
                if generation.active_requests == 0:
                    generation.drained.set()

    async def close(self) -> None:
        async with self._configure_lock:
            async with self._state_lock:
                current = self._current
                self._current = None
                if current is not None:
                    current.accepting_requests = False
            if current is not None:
                self._retire(current)

        pending = tuple(self._retiring)
        if pending:
            try:
                await asyncio.wait_for(asyncio.gather(*pending), timeout=30.0)
            except asyncio.TimeoutError:
                # 不能为了退出倒计时关闭仍被请求使用的存储；进程退出会回收剩余句柄。
                pass

    def _retire(self, generation: NarrativeGeneration) -> None:
        async def drain_and_close() -> None:
            await generation.drained.wait()
            await generation.close()

        task = asyncio.create_task(drain_and_close())
        self._retiring.add(task)
        task.add_done_callback(self._retiring.discard)
