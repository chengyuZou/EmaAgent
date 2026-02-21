"""
Narrative(剧情模式)路由器
"""

import json
import re
from typing import Dict, Optional

from llm.client import LLMClient
from prompts.story_summary_prompt import STORY_SUMMARY_PROMPT

from .exceptions import RouterError

ROUTER_PROMPT = """
你是记忆库路由器，负责把用户问题路由到正确周目。

【剧情摘要】
{summary}

【路由规则】
1. 如果用户明确指定周目，只路由到对应周目。
2. 采用“最小必要覆盖”原则：能回答就只路由 1 个周目；确有必要再路由 2 个；只有明确跨周目对比/汇总时才路由 3 个。
3. 如果摘要无法明确定位，优先选择最可能的 1 个周目；若仍不确定可路由 2 个候选周目，不要默认全三周目。
4. 跨周目问题要拆成子问题，分别路由；每个周目的子问题应只包含该周目需要回答的部分。
5. 不要为了保险而把所有问题都路由到 1st_Loop, 2nd_Loop, 3rd_Loop。

【输出要求】
只返回 JSON 对象，不要额外说明。
格式必须是：{{"1st_Loop":"子问题", "2nd_Loop":"子问题"...}}
键只允许 1st_Loop / 2nd_Loop / 3rd_Loop。
值必须是非空字符串。
请只输出“必要的键”，不要求包含全部三个周目。
"""


class Router:
    """
    Narrative(剧情模式)路由器

    负责将用户的查询路由到正确的周目(1st_Loop, 2nd_Loop, 3rd_Loop)

    并对每个周目的查询进行拆分和验证(subQuery)，确保路由结果符合预期格式和内容要求。
    """

    # 周目
    VALID_TIMELINES = {"1st_Loop", "2nd_Loop", "3rd_Loop"}

    def __init__(self, llm_client: LLMClient, summary_text: Optional[str] = None):
        self.client = llm_client

        # 游戏剧情简介
        self.summary_data = (STORY_SUMMARY_PROMPT or summary_text or "").strip()

    async def route(self, query: str) -> Dict[str, str]:
        if not isinstance(query, str) or not query.strip():
            raise RouterError("查询不能为空")
        
        # 构建 Prompt
        prompt = ROUTER_PROMPT.format(summary=self.summary_data)

        # 调用 LLM 获取路由结果
        content = await self.client.chat(
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": query},
            ],
            temperature=0.3,
            stream=False,
        )

        try:
            result = json.loads(content)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", content, re.DOTALL)
            if not match:
                raise RouterError(f"LLM 返回内容无法解析为 JSON: {content}")
            result = json.loads(match.group())

        # 如果 LLM 返回的 JSON 格式不正确，抛出错误
        if not isinstance(result, dict):
            raise RouterError(f"路由结果格式错误，期望 dict，得到 {type(result)}")
        
        # 验证周目是否合法,即键是否在 VALID_TIMELINES 中
        invalid_timelines = set(result.keys()) - self.VALID_TIMELINES
        if invalid_timelines:
            raise RouterError(f"包含非法周目: {invalid_timelines}")
        
        # 验证子问题是否为非空字符串
        for timeline, sub_query in result.items():
            if not isinstance(sub_query, str) or not sub_query.strip():
                raise RouterError(f"{timeline} 的查询内容无效: {sub_query}")

        return result
