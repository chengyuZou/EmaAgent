# Server 与 Narrative Bridge 之间的请求/响应契约。
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

# 检索模式（仅改变检索策略；最终回答永远由根 Agent 生成，Bridge 只返回背景）：
# local  — 实体/局部事实导向：low-level 关键词驱动的精确检索
# global — 关系/全局主题导向：high-level 关键词驱动的关系与主题检索
# hybrid — local + global 两路合并
# naive  — 纯向量检索：跳过关键词提取（查询时零 LLM 调用，最便宜也最粗）
# mix    — 知识图谱 + 向量双通道整合（LightRAG 上游默认，覆盖最全但最重）
QueryMode = Literal["local", "global", "hybrid", "naive", "mix"]


class LlmConnection(BaseModel):
    """一次 Recall 携带的 openai-chat 连接；Bridge 不持有任何全局 LLM 状态。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    base_url: str
    api_key: str | None = None
    model_id: str


class EmbeddingConnection(BaseModel):
    """进程级 Embedding 连接：向量空间与既有剧情数据一体，进程内不可更换。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    base_url: str
    api_key: str | None = None
    model_id: str
    dim: int = Field(..., ge=1)


class ConfigureRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    embed: EmbeddingConnection


class RecallRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    query: str = Field(..., min_length=1)
    llm: LlmConnection
    mode: QueryMode = "hybrid"
    top_k: int = Field(default=40, ge=1, le=200)


class TimelineFailureResponse(BaseModel):
    timeline: str
    code: Literal["timeline_query_failed"]
    message: str


class RecallResponse(BaseModel):
    routes: dict[str, str]
    results: dict[str, str]
    failures: list[TimelineFailureResponse]
