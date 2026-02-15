"""
Tools 模块 - 工具系统

提供：
- BaseTool: 工具基类
- ToolResult: 工具执行结果
- ToolCall: 工具调用数据结构
- ToolCollection: 工具集合
- ToolError: 工具错误异常
"""

from .base import BaseTool, ToolResult, CLIResult, ToolFailure
from .tool_collection import ToolCollection
from .tool_error import ToolError

from .webscraper import WebScraperTool
from .time import TimeTool

# 导入内置工具
from .builtin.weather import WeatherTool
from .builtin.code_exec import CodeExecutorTool
from .builtin.file_ops import FileOperationTool
from .builtin.terminal_exec import TerminalExecutorTool

# 导入搜索工具
from .search.baidusearch import BaiduSearchTool
from .search.arxiv_paper import ArxivPaperTool

# 导入文件分析工具
from .file_analysis.DocumentAnalyzer import DocumentAnalyzerTool
from .file_analysis.CodeAnalyzer import CodeAnalysisTool

__all__ = [
    # 基础类
    "BaseTool",
    "ToolResult",
    "CLIResult",
    "ToolFailure",
    "ToolCall",
    "Function",
    "ToolCollection",
    "ToolError",

    # 工具
    "WebScraperTool",
    "TimeTool",
    
    # 内置工具
    "WeatherTool",
    "CodeExecutorTool",
    "FileOperationTool",
    "TerminalExecutorTool",
    
    # 搜索工具
    "BaiduSearchTool",
    "ArxivPaperTool",
    
    # 文件分析工具
    "DocumentAnalyzerTool",
    "CodeAnalysisTool",
]
