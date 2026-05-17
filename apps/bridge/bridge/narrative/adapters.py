from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
from openai import AsyncOpenAI

if TYPE_CHECKING:
    from bridge.state import BridgeState


def make_embedding_func(state: BridgeState):
    """Return a LightRAG-compatible async embedding function backed by state's embed config."""

    async def _embed(texts: list[str]) -> np.ndarray:
        if not state.embed_ready:
            raise RuntimeError("Embed not configured")
        client = AsyncOpenAI(api_key=state.embed_api_key, base_url=state.embed_base_url)
        response = await client.embeddings.create(
            model=state.embed_model,
            input=texts,
            encoding_format="float",
        )
        vectors = np.array(
            [item.embedding for item in sorted(response.data, key=lambda x: x.index)],
            dtype=np.float32,
        )
        return vectors

    return _embed


def make_llm_func(state: BridgeState):
    """Return a LightRAG-compatible async LLM function backed by state's llm config."""

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

        # Whitelist only kwargs the OpenAI Chat Completions API actually accepts.
        # LightRAG 1.4+ passes many internal keys (hashing_kv, keyword_extraction,
        # enable_cot, …) that vary by version — safer to allow-list than block-list.
        _OPENAI_CHAT_KWARGS = {
            "temperature", "max_tokens", "max_completion_tokens",
            "top_p", "n", "stop", "stream",
            "presence_penalty", "frequency_penalty",
            "logit_bias", "seed", "user",
            "tools", "tool_choice", "functions", "function_call",
            "response_format", "logprobs", "top_logprobs",
        }
        clean_kwargs = {k: v for k, v in kwargs.items() if k in _OPENAI_CHAT_KWARGS}

        response = await client.chat.completions.create(
            model=state.llm_model,
            messages=messages,
            **clean_kwargs,
        )
        return response.choices[0].message.content or ""

    return _llm
