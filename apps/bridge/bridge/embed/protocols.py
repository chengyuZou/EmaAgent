from __future__ import annotations

from typing import Protocol, runtime_checkable

import numpy as np


@runtime_checkable
class EmbedProvider(Protocol):
    """Contract for any embedding backend."""

    @property
    def dim(self) -> int:
        """Output vector dimension."""
        ...

    async def embed(self, texts: list[str]) -> np.ndarray:
        """
        Embed a batch of texts.

        Returns
        -------
        np.ndarray
            Shape ``(N, dim)``, dtype float32.
        """
        ...

    async def health(self) -> bool:
        """Return True if the provider is reachable."""
        ...


class RerankResult:
    __slots__ = ("index", "score")

    def __init__(self, index: int, score: float) -> None:
        self.index = index
        self.score = score

    def to_dict(self) -> dict[str, float | int]:
        return {"index": self.index, "score": self.score}


@runtime_checkable
class RerankProvider(Protocol):
    """Contract for any reranking backend."""

    async def rerank(
        self,
        query: str,
        docs: list[str],
        top_k: int,
    ) -> list[RerankResult]:
        """
        Re-rank documents by relevance to query.

        Returns top_k results sorted by score descending.
        """
        ...

    async def health(self) -> bool:
        """Return True if the provider is reachable."""
        ...
