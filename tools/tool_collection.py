from typing import Any, Dict, List

# ✅ 相对导入（同包）
from .base import BaseTool, ToolResult, ToolFailure
from .tool_error import ToolError

class ToolCollection:
    """工具集合类"""

    def __init__(self, *tools: BaseTool):
        self.tools = tools
        self.tool_map = {tool.name: tool for tool in tools}

    def __iter__(self):
        return iter(self.tools)

    def to_params(self) -> List[Dict[str, Any]]:
        return [tool.to_param() for tool in self.tools]
    
    # 单步执行
    async def execute(
        self, *, name: str, tool_input: Dict[str, Any] = None
    ) -> ToolResult:
        
        tool = self.tool_map.get(name)
        if not tool:
            return ToolFailure(error=f"Tool {name} is invalid")
        try:
            result = await tool(**tool_input)
            if isinstance(result, ToolResult):
                return result
            return ToolResult(output=result)
        except ToolError as e:
            return ToolFailure(error=e.message)
        
    async def execute_all(self) -> List[ToolResult]:
        results = []
        for tool in self.tools:
            try:
                result = await tool()
                results.append(ToolResult(output=result))
            except ToolError as e:
                results.append(ToolFailure(error=e.message))
        return results
    
    def add_tool(self, tool: BaseTool):
        self.tools += (tool,)
        self.tool_map[tool.name] = tool
        return self


    def add_tools(self, *tools: BaseTool):
        for tool in tools:
            self.add_tool(tool)
        return self
