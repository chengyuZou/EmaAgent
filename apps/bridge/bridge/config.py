from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


# ── Sub-configs sent from apps/core ──────────────────────────────────────────

class EmbedCfg(BaseModel):
    """
    Currently only the openai-style /embeddings format is supported,
    so `protocol` is a Literal not an open string.
    """
    protocol: Literal["openai-embed"] = "openai-embed"
    api_key: str
    base_url: str
    model: str
    dim: int = 1024


class RerankCfg(BaseModel):
    """
    All major rerank vendors share the Cohere wire format,
    so no protocol discriminator is needed.
    """
    api_key: str
    base_url: str
    model: str


class LlmCfg(BaseModel):
    """
    LLM connection forwarded from apps/core's openai-compat provider.
    Used by LightRAG for entity extraction and query routing — not for chat.
    """
    api_key: str
    base_url: str
    model: str


# ── Configure request ─────────────────────────────────────────────────────────

class ConfigureRequest(BaseModel):
    """
    Payload for POST /internal/configure.
    apps/core sends this on startup (and on settings change). All fields
    are optional — bridge only updates what's provided.
    """
    embed:  EmbedCfg  | None = Field(default=None)
    rerank: RerankCfg | None = Field(default=None)
    llm:    LlmCfg    | None = Field(default=None)
