# 复用同一代 Provider 客户端，并向 LightRAG 提供窄适配函数。
from __future__ import annotations

import numpy as np
from openai import AsyncOpenAI

from ..configuration import NarrativeProviderSnapshot

OPENAI_CHAT_KWARGS = frozenset(
    {
        "temperature",
        "max_tokens",
        "max_completion_tokens",
        "top_p",
        "n",
        "stop",
        "stream",
        "presence_penalty",
        "frequency_penalty",
        "logit_bias",
        "seed",
        "user",
        "tools",
        "tool_choice",
        "functions",
        "function_call",
        "response_format",
        "logprobs",
        "top_logprobs",
    }
)


class NarrativeModelClients:

    def __init__(self, snapshot: NarrativeProviderSnapshot) -> None:
        self._snapshot = snapshot
        self.embed = AsyncOpenAI(
            api_key=snapshot.embed_api_key,
            base_url=snapshot.embed_base_url,
        )
        self.llm = AsyncOpenAI(
            api_key=snapshot.llm_api_key,
            base_url=snapshot.llm_base_url,
        )

    @property
    def llm_model(self) -> str:
        return self._snapshot.llm_model

    async def embed_texts(self, texts: list[str]) -> np.ndarray:
        response = await self.embed.embeddings.create(
            model=self._snapshot.embed_model,
            input=texts,
            encoding_format="float",
        )
        return np.array(
            [item.embedding for item in sorted(response.data, key=lambda item: item.index)],
            dtype=np.float32,
        )

    async def complete_for_lightrag(
        self,
        prompt: str,
        system_prompt: str | None = None,
        history_messages: list[dict] | None = None,
        **kwargs,
    ) -> str:
        messages: list[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        if history_messages:
            messages.extend(history_messages)
        messages.append({"role": "user", "content": prompt})
        clean_kwargs = {
            key: value for key, value in kwargs.items() if key in OPENAI_CHAT_KWARGS
        }
        response = await self.llm.chat.completions.create(
            model=self._snapshot.llm_model,
            messages=messages,
            **clean_kwargs,
        )
        return response.choices[0].message.content or ""

    async def close(self) -> None:
        await self.embed.close()
        await self.llm.close()
