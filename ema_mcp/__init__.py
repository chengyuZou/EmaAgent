"""
MCP 工具模块 — 桥接 MCP 远程工具到 EmaAgent 工具系统

架构:
    ┌────────────────────────────────────────────────────────────┐
    │  tools/mcp/                                                │
    │                                                            │
    │  MCPManager      管理所有 MCP Server 的生命周期             │
    │       │          从 config 读取 servers 配置               │
    │       │          启动/停止/重连 Server 子进程               │
    │       ▼                                                    │
    │  MCPClient       单个 MCP Server 的连接（mcp SDK 封装）     │
    │       │          stdio 管道 + Content-Length + JSON-RPC     │
    │       ▼                                                    │
    │  MCPToolBridge   适配器: MCP Tool → BaseTool               │
    │                  让 ReAct Agent 无感知调用远程 MCP 工具      │
    └────────────────────────────────────────────────────────────┘

用法:
    from tools.mcp import MCPManager

    manager = MCPManager()
    await manager.start_all()           # 启动所有配置的 MCP Server
    tools = manager.get_all_tools()     # 获取所有 MCPToolBridge 实例
    agent.tools.add_tools(*tools)       # 注入到 ReAct ToolCollection

    await manager.stop_all()            # 关闭所有 Server
"""

from .client import MCPClient
from .bridge import MCPToolBridge
from .manager import MCPManager

__all__ = [
    "MCPClient",
    "MCPToolBridge",
    "MCPManager",
]
