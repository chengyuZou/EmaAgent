from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class EmbedCfg(BaseModel):
    """
    Embed provider config pushed from apps/core for LightRAG's internal use.
    Accepts camelCase JSON keys (apiKey, baseUrl) from the TS client.
    """
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    protocol: str = Field(default="openai-embed")
    api_key:  str
    base_url: str
    model:    str
    dim:      int = 1024


class LlmCfg(BaseModel):
    """
    LLM config for LightRAG's entity extraction and query routing.
    Accepts camelCase JSON keys (apiKey, baseUrl) from the TS client.
    """
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    api_key:  str
    base_url: str
    model:    str


class ConfigureRequest(BaseModel):
    """
    Payload for POST /internal/configure.
    No rerank — LightRAG only needs embed + llm internally.
    """
    # 这是完整快照而不是 PATCH：null 明确表示清除旧配置和密钥。
    embed: EmbedCfg | None
    llm:   LlmCfg   | None
