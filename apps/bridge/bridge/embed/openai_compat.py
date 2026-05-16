from __future__ import annotations

import numpy as np
from openai import AsyncOpenAI


class OpenAICompatEmbedder:
    """
    Embedding provider for any OpenAI-compatible /embeddings endpoint.

    Covers: SiliconFlow, OpenAI, Jina, Voyage AI, and any other provider
    that accepts the standard ``{model, input: list[str]}`` request body.
    """

    def __init__(
        self,
        model: str,
        api_key: str,
        base_url: str,
        dim: int,
        timeout: float = 30.0,
    ) -> None:
        self._model = model
        self._dim = dim
        self._client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
        )

    @property
    def dim(self) -> int:
        return self._dim

    async def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            raise ValueError("texts must be a non-empty list")

        response = await self._client.embeddings.create(
            model=self._model,
            input=texts,
            encoding_format="float",
        )

        vectors = np.array(
            [item.embedding for item in response.data],
            dtype=np.float32,
        )

        if vectors.ndim != 2 or vectors.shape[1] != self._dim:
            raise ValueError(
                f"Unexpected embedding shape {vectors.shape}, expected (N, {self._dim})"
            )

        return vectors

    async def health(self) -> bool:
        try:
            await self._client.embeddings.create(
                model=self._model,
                input=["ping"],
                encoding_format="float",
            )
            return True
        except Exception:
            return False

    def __repr__(self) -> str:
        return (
            f"OpenAICompatEmbedder(model={self._model!r}, "
            f"base_url={self._client.base_url!r}, dim={self._dim})"
        )
