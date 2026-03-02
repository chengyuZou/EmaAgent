"""
MCPToolBridge — MCP 远程工具 → BaseTool 适配器

核心思想:
    MCP Server 暴露的每个 Tool 都被包装成一个 BaseTool 实例，
    这样 ReAct Agent 的 ToolCollection 可以无感知地调用远程工具。

映射关系:
    MCP Tool                    BaseTool
    ─────────────────────       ─────────────────────
    name                   →    name
    description            →    description
    inputSchema            →    parameters
    call_tool(name, args)  →    execute(**kwargs) → ToolResult

数据流:
    ReActAgent
      └─ ToolCollection.execute(name="maps_geo", tool_input={...})
           └─ MCPToolBridge.execute(**kwargs)
                └─ MCPClient.call_tool("maps_geo", kwargs)
                     └─ ClientSession → stdio → MCP Server
                          └─ {"content": [...], "isError": false}
                               └─ ToolResult(output="...")
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional, List

from tools.base import BaseTool, ToolResult
from .client import MCPClient

from utils.logger import logger


class MCPToolBridge(BaseTool):
    """
    MCP Tool → BaseTool 适配器

    将单个 MCP 远程工具伪装成 EmaAgent 的本地 BaseTool，
    使其可以被 ToolCollection 管理、被 ReAct Agent 调用。

    特点:
      - name / description / parameters 直接映射 MCP 元数据
      - execute() 内部通过 MCPClient.call_tool() 远程调用
      - 自动将 MCP 结果（content items）转换为 ToolResult
      - 支持错误传播（MCP isError → ToolResult.error）

    Example:
    ```python
        client = MCPClient(name="amap")
        await client.start(...)

        # 为每个 MCP Tool 创建一个 Bridge
        bridges = MCPToolBridge.from_mcp_client(client)
        agent.tools.add_tools(*bridges)
    ```
    """

    # Pydantic 不序列化这些字段（它们是运行时状态）
    # BaseTool 继承自 BaseModel，所以需要 model_config
    model_config = {"arbitrary_types_allowed": True}

    # MCPClient 引用（会在 __init__ 之后设置）
    _mcp_client: MCPClient = None
    _server_name: str = ""

    def __init__(
        self,
        *,
        name: str,
        description: str,
        parameters: Optional[Dict[str, Any]] = None,
        mcp_client: MCPClient,
        server_name: str = "",
    ) -> None:
        """
        Args:
            name:        MCP Tool 名称（如 "maps_geo"）
            description: MCP Tool 描述
            parameters:  MCP Tool 的 inputSchema (JSON Schema)
            mcp_client:  MCPClient 实例的引用
            server_name: 所属 MCP Server 名称（用于日志）
        """
        super().__init__(
            name=name,
            description=description,
            parameters=parameters or {"type": "object", "properties": {}},
        )
        # 使用 object.__setattr__ 绕过 Pydantic frozen model
        object.__setattr__(self, "_mcp_client", mcp_client)
        object.__setattr__(self, "_server_name", server_name)

    async def execute(self, **kwargs: Any) -> ToolResult:
        """
        执行 MCP 远程工具调用

        Args:
            **kwargs: 工具参数（由 ReAct Agent 从 LLM tool_calls 中解析）

        Returns:
            ToolResult: 包含输出文本或错误信息
        """
        tool_name = self.name
        logger.info(f"[MCPBridge:{self._server_name}] 调用 {tool_name}")
        logger.debug(f"[MCPBridge:{self._server_name}] 参数: {json.dumps(kwargs, ensure_ascii=False)}")

        try:
            # 调用 MCP Server
            mcp_result = await self._mcp_client.call_tool(tool_name, kwargs)

            # 提取文本内容
            output = _extract_text(mcp_result)
            is_error = _is_error(mcp_result)

            if is_error:
                logger.warning(f"[MCPBridge:{self._server_name}] {tool_name} 返回错误: {output[:200]}")
                return self.fail_response(output)

            logger.debug(f"[MCPBridge:{self._server_name}] {tool_name} 成功, 输出长度: {len(output)}")
            return self.success_response(output)

        except Exception as e:
            error_msg = f"MCP 工具调用异常 [{self._server_name}/{tool_name}]: {e}"
            logger.error(error_msg, exc_info=True)
            return self.fail_response(error_msg)

    # ── 工厂方法 ────────────────────────────────────────────────────

    @classmethod
    def from_mcp_client(cls, client: MCPClient) -> List["MCPToolBridge"]:
        """
        从 MCPClient 的已缓存工具列表批量创建 Bridge 实例

        Args:
            client: MCPClient 实例（必须已 start() 并缓存了 tools）

        Returns:
            MCPToolBridge 实例列表，每个对应一个 MCP Tool
        """
        bridges: List[MCPToolBridge] = []
        server_name = client.name if hasattr(client, "name") else "mcp"

        for tool_meta in client.tools:
            bridge = cls(
                name=tool_meta["name"],
                description=tool_meta.get("description", ""),
                parameters=tool_meta.get("inputSchema", {"type": "object", "properties": {}}),
                mcp_client=client,
                server_name=server_name,
            )
            bridges.append(bridge)

        logger.info(
            f"[MCPBridge] 从 {server_name} 创建了 {len(bridges)} 个工具桥接: "
            f"{[b.name for b in bridges]}"
        )
        return bridges


# ════════════════════════════════════════════════════════════════════
#  辅助函数（从 test/mcp/react_agent.py 提取复用）
# ════════════════════════════════════════════════════════════════════


def _extract_text(mcp_result: Dict[str, Any]) -> str:
    """
    从 MCP tools/call 响应中提取文本内容

    格式: {"content": [{"type": "text", "text": "..."}], "isError": false}
    """
    content_items = mcp_result.get("content", [])
    texts = []
    for item in content_items:
        if not isinstance(item, Dict):
            continue
        if item.get("type") == "text":
            texts.append(item.get("text", ""))
    return "\n".join(texts) if texts else json.dumps(mcp_result, ensure_ascii=False)


def _is_error(mcp_result: Dict[str, Any]) -> bool:
    """检查 MCP 结果是否为错误（兼容 isError / is_error）"""
    return bool(mcp_result.get("isError") or mcp_result.get("is_error", False))
