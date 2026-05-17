from __future__ import annotations

from pydantic import BaseModel, Field


class EmbedCfg(BaseModel):
    """
    Embed provider config pushed from apps/core for LightRAG's internal use.
    Not exposed as a public /embed endpoint — LightRAG calls the provider directly.
    """
    protocol: str = Field(default="openai-embed")
    api_key: str
    base_url: str
    model: str
    dim: int = 1024


class LlmCfg(BaseModel):
    """
    LLM config for LightRAG's entity extraction and query routing.
    Shares the same openai-compat provider selected in model_bindings.
    """
    api_key: str
    base_url: str
    model: str


class ConfigureRequest(BaseModel):
    """
    Payload for POST /internal/configure.
    No rerank — LightRAG only needs embed + llm internally.
    """
    embed: EmbedCfg | None = Field(default=None)
    llm:   LlmCfg   | None = Field(default=None)
