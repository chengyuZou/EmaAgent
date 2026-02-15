"""
RAG 管理器模块
"""

import asyncio
from typing import Dict, Any
from lightrag import LightRAG, QueryParam

from .llm_function import llm_func
from .embedding import create_embedding_func
from .exceptions import RAGError

from utils.logger import logger

class RAGManager:
    """
    RAG 管理器 - 管理多个周目的 LightRAG 实例

    三个周目的剧情分别对应三个LightRAG实例,负责加载和查询各自的记忆库。
    """
    
    def __init__(self, timeline_dirs: Dict[str, str]):
        """
        初始化 RAG 管理器
        
        Args:
            timeline_dirs: {timeline: dir_path} 字典
        """
        self.timeline_dirs = timeline_dirs
        self.rags: Dict[str, LightRAG] = {}
        self._initialized = False

    async def initialize(self):
        """
        初始化所有 RAG 实例
        
        Raises:
            RAGError: 初始化失败
        """
        if self._initialized:
            logger.warning("⚠ RAG 已初始化,跳过")
            return
        
        try:
            # 一个周目(timeline)对应一个 LightRAG 实例
            for timeline, dir_path in self.timeline_dirs.items():
                rag = LightRAG(
                    working_dir=dir_path,
                    llm_model_func=llm_func,
                    embedding_func=create_embedding_func(),
                )
                await rag.initialize_storages()
                self.rags[timeline] = rag
                logger.info(f"✓ {timeline} RAG 初始化完成")
            
            self._initialized = True
            
        except Exception as e:
            raise RAGError(f"RAG 初始化失败: {e}")

    async def query(
        self,
        timeline: str,
        query: str,
        mode: str = "hybrid",
        top_k: int = 40
    ) -> str:
        """
        查询指定周目的 RAG
        
        Args:
            timeline: 周目名称
            query: 查询内容
            mode: 查询模式 (local/global/hybrid)
            top_k: 返回结果数量
            
        Returns:
            查询结果
            
        Raises:
            RAGError: 查询失败
        """
        # 如果没有初始化，抛出错误
        if not self._initialized:
            raise RAGError("RAG 未初始化,请先调用 initialize()")
        
        # 验证周目是否存在
        if timeline not in self.rags:
            raise RAGError(f"周目 {timeline} 不存在")
        
        # 验证查询内容是否有效
        if not isinstance(query, str) or not query.strip():
            raise RAGError("查询内容不能为空")
        
        try:
            # 取出对应周目的 LightRAG 实例进行查询
            rag = self.rags[timeline]

            # 构建查询参数
            param = QueryParam(
                mode=mode,
                only_need_context=True,
                top_k=top_k
            )
            result = await rag.aquery(query=query, param=param)
            return result
            
        except Exception as e:
            raise RAGError(f"{timeline} 查询失败: {e}")

    async def batch_query(
        self,
        queries: Dict[str, str],
        mode: str = "hybrid",
        top_k: int = 40
    ) -> Dict[str, str]:
        """
        批量查询多个周目
        
        Args:
            queries: {timeline: query} 字典
            mode: 查询模式
            top_k: 返回结果数量
            
        Returns:
            {timeline: result} 字典
            
        Raises:
            RAGError: 批量查询失败
        """
        # 如果 queries 为空，直接返回空结果
        if not queries:
            return {}
        
        try:
            # 使用 asyncio.gather 并发查询多个周目，提升效率
            tasks = []
            timelines = []
            
            for timeline, query in queries.items():
                tasks.append(self.query(timeline, query, mode, top_k))
                timelines.append(timeline)
            
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            # 处理异常
            final_results = {}
            for timeline, result in zip(timelines, results):
                # 如果查询失败，记录错误信息；没出错则直接返回查询结果
                if isinstance(result, Exception):
                    logger.warning(f"⚠ {timeline} 查询失败: {result}")
                    final_results[timeline] = f"[查询失败: {result}]"
                else:
                    final_results[timeline] = result
            
            return final_results
            
        except Exception as e:
            raise RAGError(f"批量查询失败: {e}")

    async def finalize(self):
        """
        关闭所有 RAG 实例
        """
        for timeline, rag in self.rags.items():
            try:
                await rag.finalize_storages()
                logger.info(f"✓ {timeline} RAG 已关闭")
            except Exception as e:
                logger.warning(f"⚠ {timeline} RAG 关闭失败: {e}")
        
        self._initialized = False
        self.rags.clear()