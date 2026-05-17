from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
from openai import AsyncOpenAI

if TYPE_CHECKING:
    from bridge.state import BridgeState


def make_embedding_func(state: BridgeState):
    """Wrap BridgeState.embedder as a LightRAG-compatible async embedding function."""

    async def _embed(texts: list[str]) -> np.ndarray:
        if state.embedder is None:
            raise RuntimeError("Embed provider not configured")
        return await state.embedder.embed(texts)

    return _embed


def make_llm_func(state: BridgeState):
    """Wrap BridgeState LLM config as a LightRAG-compatible async LLM function."""

    async def _llm(
        prompt: str,
        system_prompt: str | None = None,
        history_messages: list[dict] | None = None,
        **kwargs,
    ) -> str:
        if not state.llm_ready:
            raise RuntimeError("LLM not configured")

        client = AsyncOpenAI(api_key=state.llm_api_key, base_url=state.llm_base_url)
        messages: list[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        if history_messages:
            messages.extend(history_messages)
        messages.append({"role": "user", "content": prompt})

        response = await client.chat.completions.create(
            model=state.llm_model,
            messages=messages,
            **{k: v for k, v in kwargs.items() if k not in ("hashing_kv",)},
        )
        return response.choices[0].message.content or ""

    return _llm
