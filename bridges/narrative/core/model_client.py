# 一次 Recall 的 openai-chat 客户端与进程级 Embedding 闭包。
from __future__ import annotations

import numpy as np
from lightrag.utils import EmbeddingFunc
from openai import AsyncOpenAI

from .contracts import LlmConnection

# OpenAI SDK 构造期强制 api_key 非空；本地/受信网关不校验该值。
PLACEHOLDER_API_KEY = "ema-no-key"

# LightRAG 的 model_func 透传 kwargs 里只有这些是 openai-chat 协议字段。
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


class RecallLlmClient:
    """单次 Recall 的连接 路由与全部时间线的关键词提取共用 Recall 结束即关。"""

    def __init__(self, connection: LlmConnection) -> None:
        self._model = connection.model_id
        self._client = AsyncOpenAI(
            api_key=connection.api_key or PLACEHOLDER_API_KEY,
            base_url=connection.base_url,
        )

    async def route_completion(self, system_prompt: str, query: str) -> str:
        response = await self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": query},
            ],
            temperature=0.2,
        )
        return response.choices[0].message.content or ""

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
        response = await self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            **clean_kwargs,
        )
        return response.choices[0].message.content or ""

    async def close(self) -> None:
        await self._client.close()


def build_embedding_func(
    *,
    base_url: str,
    api_key: str | None,
    model: str,
    dim: int,
) -> EmbeddingFunc:
    """进程级 Embedding 闭包：Bridge 启动时构造一次，向量空间与既有剧情数据一体，不热切换。"""
    client = AsyncOpenAI(api_key=api_key or PLACEHOLDER_API_KEY, base_url=base_url)

    async def embed_texts(texts: list[str]) -> np.ndarray:
        response = await client.embeddings.create(
            model=model,
            input=texts,
            encoding_format="float",
        )
        return np.array(
            [item.embedding for item in sorted(response.data, key=lambda item: item.index)],
            dtype=np.float32,
        )

    return EmbeddingFunc(embedding_dim=dim, max_token_size=8192, func=embed_texts)
