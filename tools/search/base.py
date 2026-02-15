from abc import ABC, abstractmethod
from typing import Any, Dict, List
from ..base import BaseTool

from ..base import ToolResult,ToolFailure

class SearchEngineBase(BaseTool, ABC):
    """搜索引擎基类"""

    description: str = "搜索引擎"
    parameters: dict = {
        "type": "object",
        "properties": {
                "query": {
                "type": "string",
                    "description": "搜索关键词"
                },
                "num_results": {
                    "type": "integer",
                    "description": "返回结果数量，默认10条",
                    "default": 10
                }
            },
            "required": ["query"]
        }
    


    @abstractmethod
    async def perform_search(self, query: str, num_results: int = 10) -> List[Dict[str, Any]]:
        """执行搜索操作

        Args:
            query (str): 搜索关键词
            num_results (int, optional): 搜索结果数量，默认10条

        Returns:
            List[Tuple[str, str]]: 搜索结果列表，每个结果是一个元组，包含标题和链接
        
        """
        pass

    async def execute(self, query: str, num_results: int = 10, **kwargs) -> ToolResult:
        """执行搜索操作

        Args:
            query (str): 搜索关键词
            num_results (int, optional): 返回结果数量，默认10条
            kwargs: 其他参数

        Returns:
            Dict: 包含搜索结果的字典
        """
        try:
            results = await self.perform_search(query, num_results)
            return ToolResult(output=results)
        
        except Exception as e:
            return ToolFailure(error=f"搜索执行失败: {str(e)}")
            


