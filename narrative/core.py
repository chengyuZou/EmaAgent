"""
Narrative memory service.
"""

import json
from typing import Dict, Optional

from llm.client import LLMClient
from prompts.story_summary_prompt import STORY_SUMMARY_PROMPT

from narrative.exceptions import NarrativeMemoryError
from narrative.rag_manager import RAGManager
from narrative.router import Router


class NarrativeMemory:
    """
    剧情记忆系统
    - Router 负责将用户的查询路由到正确的周目(1st_Loop, 2nd_Loop, 3rd_Loop)\n
    - RAGManager 管理多个周目的 LightRAG 实例，负责加载和查询各自的记忆库。
    """

    def __init__(
        self,
        llm_client: LLMClient,
        timeline_dirs: Dict[str, str],
        summary_text: Optional[str] = None,
    ):
        """
        初始化 NarrativeMemory

        Args:
            llm_client: LLM 客户端实例
            timeline_dirs: {timeline: dir_path} 字典，指定每个周目的记忆库目录
            summary_text: 游戏剧情简介文本，可选,但尽量别选,默认为 STORY_SUMMARY_PROMPT
        """
        # 验证 timeline_dirs 是否提供且不为空
        if not timeline_dirs:
            raise NarrativeMemoryError("必须提供 timeline_dirs 参数")
        
        self.timeline_dirs = timeline_dirs
        self.summary_text = (summary_text or STORY_SUMMARY_PROMPT or "").strip()

        try:
            self.router = Router(llm_client=llm_client, summary_text=self.summary_text)
            self.rag_manager = RAGManager(timeline_dirs=self.timeline_dirs)
            self._initialized = False
        except Exception as exc:
            raise NarrativeMemoryError(f"NarrativeMemory 初始化失败: {exc}")

    async def initialize(self):
        # 如果已经初始化，直接返回
        if self._initialized:
            return

        try:
            # 等待 RAGManager 初始化完成
            await self.rag_manager.initialize()
            self._initialized = True
            print("✅ NarrativeMemory initialized")
        except Exception as exc:
            raise NarrativeMemoryError(f"初始化失败: {exc}")

    async def query(self, query: str, mode: str = "hybrid", top_k: int = 20) -> Dict[str, str]:
        if not self._initialized:
            raise NarrativeMemoryError("记忆体未初始化，请先调用 initialize()")

        try:
            route_result = await self.router.route(query)
            print(f"📍 路由结果: {json.dumps(route_result, ensure_ascii=False)}")
            results = await self.rag_manager.batch_query(queries=route_result, mode=mode, top_k=top_k)
            print(f"✅ 查询完成，共 {len(results)} 个周目")
            return results
        except Exception as exc:
            raise NarrativeMemoryError(f"查询失败: {exc}")

    async def finalize(self):
        await self.rag_manager.finalize()
        self._initialized = False
        print("✅ NarrativeMemory 已关闭")

    def get_summary(self) -> str:
        return self.summary_text
