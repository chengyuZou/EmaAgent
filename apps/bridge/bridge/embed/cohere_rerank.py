from __future__ import annotations

import httpx

from bridge.embed.protocols import RerankResult


class CohereStyleReranker:
    """
    Rerank provider for the Cohere-style /rerank endpoint.

    Cohere defined this wire format; Jina, SiliconFlow, and Voyage all use it:

        POST {base_url}/rerank
        {"model": "...", "query": "...", "documents": [...], "top_n": N}

        Response:
        {"results": [{"index": N, "relevance_score": 0.9, "document": {...}}]}
    """

    def __init__(
        self,
        model: str,
        api_key: str,
        base_url: str,
        timeout: float = 30.0,
    ) -> None:
        self._model = model
        # Ensure /rerank path is absolute — strip trailing slash from base_url.
        self._rerank_url = base_url.rstrip("/") + "/rerank"
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        self._timeout = timeout

    async def rerank(
        self,
        query: str,
        docs: list[str],
        top_k: int,
    ) -> list[RerankResult]:
        if not query or not docs:
            raise ValueError("query and docs must be non-empty")

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(
                self._rerank_url,
                headers=self._headers,
                json={
                    "model": self._model,
                    "query": query,
                    "documents": docs,
                    "top_n": top_k,
                },
            )
            resp.raise_for_status()
            data = resp.json()

        results = [
            RerankResult(
                index=r["index"],
                score=float(r.get("relevance_score", r.get("score", 0.0))),
            )
            for r in data.get("results", [])
        ]
        results.sort(key=lambda r: r.score, reverse=True)
        return results[:top_k]

    async def health(self) -> bool:
        try:
            await self.rerank("test", ["test document"], top_k=1)
            return True
        except Exception:
            return False

    def __repr__(self) -> str:
        return f"CohereStyleReranker(model={self._model!r}, url={self._rerank_url!r})"
