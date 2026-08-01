# 使用本代 LLM 把用户问题拆到最少必要的剧情时间线。
from __future__ import annotations

import json
import re

from .contentPaths import TIMELINES
from .modelClients import NarrativeModelClients
from .narrativePrompt import STORY_SUMMARY, ROUTER_PROMPT_TEMPLATE

_JSON_PATTERN = re.compile(r"\{[\s\S]*\}", re.DOTALL)
_VALID_TIMELINES = frozenset(TIMELINES)


class NarrativeRouter:
    def __init__(self, clients: NarrativeModelClients) -> None:
        self._clients = clients

    async def route(self, query: str) -> dict[str, str]:
        normalized_query = query.strip()
        if not normalized_query:
            raise ValueError("query must not be empty")

        response = await self._clients.llm.chat.completions.create(
            model=self._clients.llm_model,
            messages=[
                {
                    "role": "system",
                    "content": ROUTER_PROMPT_TEMPLATE.format(summary=STORY_SUMMARY),
                },
                {"role": "user", "content": normalized_query},
            ],
            temperature=0.2,
        )
        content = (response.choices[0].message.content or "").strip()

        try:
            result = json.loads(content)
        except json.JSONDecodeError:
            match = _JSON_PATTERN.search(content)
            if match is None:
                raise ValueError("Narrative 路由模型没有返回 JSON 对象")
            result = json.loads(match.group())

        if not isinstance(result, dict):
            raise ValueError("Narrative 路由模型返回值不是对象")
        invalid = set(result) - _VALID_TIMELINES
        if invalid:
            raise ValueError(f"Narrative 路由包含未知时间线: {sorted(invalid)}")

        routes = {
            timeline: sub_query.strip()
            for timeline, sub_query in result.items()
            if isinstance(sub_query, str) and sub_query.strip()
        }
        if not routes:
            raise ValueError("Narrative 路由没有生成可执行的子问题")
        return routes
