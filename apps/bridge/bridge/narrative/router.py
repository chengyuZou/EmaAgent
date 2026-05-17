from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING

from openai import AsyncOpenAI

if TYPE_CHECKING:
    from bridge.state import BridgeState

VALID_TIMELINES = frozenset({"1st_Loop", "2nd_Loop", "3rd_Loop"})

# Game story summary injected into the router prompt at runtime.
# Not user-configurable — edit this constant to update the narrative context.
STORY_SUMMARY: str = ""

_ROUTER_PROMPT_TEMPLATE = """
你是记忆库路由器，负责把用户问题路由到正确周目。

【剧情摘要】
{summary}

【路由规则】
1. 如果用户明确指定周目，只路由到对应周目。
2. 采用"最小必要覆盖"原则：能回答就只路由 1 个周目；确有必要再路由 2 个；只有明确跨周目对比/汇总时才路由 3 个。
3. 如果摘要无法明确定位，优先选择最可能的 1 个周目；若仍不确定可路由 2 个候选周目，不要默认全三周目。
4. 跨周目问题要拆成子问题，分别路由；每个周目的子问题应只包含该周目需要回答的部分。
5. 不要为了保险而把所有问题都路由到 1st_Loop, 2nd_Loop, 3rd_Loop。

【输出要求】
只返回 JSON 对象，不要额外说明。
格式必须是：{{"1st_Loop":"子问题", "2nd_Loop":"子问题"...}}
键只允许 1st_Loop / 2nd_Loop / 3rd_Loop。
值必须是非空字符串。
请只输出"必要的键"，不要求包含全部三个周目。
"""

_JSON_PATTERN = re.compile(r"\{[\s\S]*\}", re.DOTALL)


class NarrativeRouter:
    """
    Uses the configured LLM to route a user query to relevant timelines
    and rewrite sub-queries optimised for LightRAG retrieval.
    """

    def __init__(self, state: BridgeState) -> None:
        self._state = state

    async def route(self, query: str) -> dict[str, str]:
        if not query.strip():
            raise ValueError("query must not be empty")

        s = self._state
        if not s.llm_ready:
            raise RuntimeError("LLM not configured")

        client = AsyncOpenAI(api_key=s.llm_api_key, base_url=s.llm_base_url)
        system_prompt = _ROUTER_PROMPT_TEMPLATE.format(summary=STORY_SUMMARY)
        response = await client.chat.completions.create(
            model=s.llm_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": query},
            ],
            temperature=0.2,
        )

        content = (response.choices[0].message.content or "").strip()

        # Try direct parse first, then regex extraction as fallback.
        try:
            result = json.loads(content)
        except json.JSONDecodeError:
            match = _JSON_PATTERN.search(content)
            if not match:
                raise ValueError(f"Router LLM returned non-JSON content: {content!r}")
            result = json.loads(match.group())

        if not isinstance(result, dict):
            raise ValueError(f"Router expected dict, got {type(result).__name__}")

        invalid = set(result.keys()) - VALID_TIMELINES
        if invalid:
            raise ValueError(f"Router returned invalid timelines: {invalid}")

        # Drop any entries with blank sub-queries.
        return {k: v for k, v in result.items() if isinstance(v, str) and v.strip()}
