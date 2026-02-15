#大概率用不了
from googlesearch import search
from ..base import BaseTool
from typing import Dict,Any
from .base import SearchEngineBase

class GoogleSearchTool(SearchEngineBase):
    """Google搜索工具"""

    def __init__(self):
        """初始化Google搜索工具"""
        super().__init__()
        
        self.name = "google_search"
        self.description = "使用Google搜索引擎查询信息"


    async def perform_search(self, query: str, num_results: int = 10, **kwargs) -> list[Dict[str, Any]]:
        """执行谷歌搜索"""
        try:

            # 配置代理 (如果需要)
            # proxies = {
            #     'http': 'http://127.0.0.1:7890',  # 替换为你的代理地址
            #     'https': 'http://127.0.0.1:7890'
            # }

            raw_results = search(query, num_results=num_results, advanced=True)

            results = []
            for i , item in enumerate(raw_results):
                if isinstance(item, str):
                    # 如果是URL
                    results.append(
                        {
                            "title": f"Google Result {i+1}",
                            "url": item,
                            "description": "",
                            "rank": i+1
                        }
                    )
                else:
                    results.append(
                        {
                            "title": item.title,
                            "url": item.url,
                            "description": item.description,
                            "rank": i+1
                        }
                    )

            return results

        except Exception as e:
            return [
                {
                    "title": "Error",
                    "url": "",
                    "description": str(e),
                    "rank": 1
                }
            ]
        