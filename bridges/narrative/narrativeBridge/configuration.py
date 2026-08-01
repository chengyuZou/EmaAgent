# 定义 LocalHost 推送给 Narrative Bridge 的完整模型配置快照。
from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class EmbedConfig(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    protocol: str = Field(default="openai-embed")
    api_key: str
    base_url: str
    model: str
    dim: int = Field(default=1024, gt=0)


class LlmConfig(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    api_key: str
    base_url: str
    model: str


class ConfigureRequest(BaseModel):
    """完整快照；任一字段为 null 都表示撤销 Narrative 运行能力。"""

    embed: EmbedConfig | None
    llm: LlmConfig | None


@dataclass(frozen=True, slots=True)
class NarrativeProviderSnapshot:
    embed_api_key: str
    embed_base_url: str
    embed_model: str
    embed_dim: int
    llm_api_key: str
    llm_base_url: str
    llm_model: str

    @classmethod
    def from_request(
        cls,
        request: ConfigureRequest,
    ) -> NarrativeProviderSnapshot | None:
        if request.embed is None or request.llm is None:
            return None
        return cls(
            embed_api_key=request.embed.api_key,
            embed_base_url=request.embed.base_url,
            embed_model=request.embed.model,
            embed_dim=request.embed.dim,
            llm_api_key=request.llm.api_key,
            llm_base_url=request.llm.base_url,
            llm_model=request.llm.model,
        )
