# tools/builtin/search.py
from baidusearch.baidusearch import search
from typing import Dict,Any
from .base import SearchEngineBase


class BaiduSearchTool(SearchEngineBase):
    """百度搜索工具"""

    name: str = "baidu_search"
    description: str = "使用百度搜索引擎查询信息"

    
    async def perform_search(self, query: str, num_results: int = 10) -> list[Dict[str, Any]]:
        """执行百度搜索"""
        try:
            results = search(query, num_results=num_results)
            return results
        except Exception as e:
            return [
                {
                    "title": "百度搜索失败",
                    "url": "",
                    "description": str(e),
                    "rank": 1
                }
            ]