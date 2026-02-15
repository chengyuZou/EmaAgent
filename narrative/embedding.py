"""
构建LightRAG所需要的文本嵌入函数
使用 OpenAI 的 Embedding API 来生成文本的向量表示
"""

import numpy as np
from openai import AsyncOpenAI
from lightrag.utils import EmbeddingFunc

from .exceptions import EmbeddingError
from config.paths import get_paths


def _get_embedding_config():
    config = get_paths().load_config()
    return config.get("embeddings", {})


async def siliconflow_embedding_func(texts: list[str]) -> np.ndarray:
    if not texts:
        return np.array([])

    if not isinstance(texts, list):
        raise EmbeddingError(f"texts must be list, got {type(texts)}")

    valid_texts = [t for t in texts if isinstance(t, str) and t.strip()]
    if not valid_texts:
        raise EmbeddingError("all texts are empty")

    embedding_cfg = _get_embedding_config()

    try:
        client = AsyncOpenAI(
            api_key=embedding_cfg.get("api_key", ""),
            base_url=embedding_cfg.get("base_url"),
        )

        response = await client.embeddings.create(
            model=embedding_cfg.get("model"),
            input=valid_texts,
            encoding_format="float",
        )

        embeddings = np.array([x.embedding for x in response.data])
        expect_dim = embedding_cfg.get("embedding_dim", 1024)

        if embeddings.shape[1] != expect_dim:
            raise EmbeddingError(
                f"embedding dim mismatch: expected {expect_dim}, got {embeddings.shape[1]}"
            )

        return embeddings

    except EmbeddingError:
        raise
    except Exception:
        expect_dim = embedding_cfg.get("embedding_dim", 1024)
        return np.zeros((len(valid_texts), expect_dim))


def create_embedding_func() -> EmbeddingFunc:
    embedding_cfg = _get_embedding_config()
    return EmbeddingFunc(
        embedding_dim=embedding_cfg.get("embedding_dim", 1024),
        func=siliconflow_embedding_func,
        max_token_size=8192,
    )
