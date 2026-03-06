"""
MCP Client — 基于 mcp SDK 的薄封装

封装 mcp 官方包的异步上下文管理器为普通的 start/stop 生命周期，
方便在 EmaAgent 的组件初始化/销毁流程中使用。

核心依赖:
    mcp.client.stdio.StdioServerParameters  — Server 启动参数
    mcp.client.stdio.stdio_client           — 拉起子进程 + stdio 管道
    mcp.client.session.ClientSession        — JSON-RPC 会话管理

数据流:
    MCPClient ──► ClientSession ──► stdio_client ──► MCP Server 子进程
                  (JSON-RPC)       (Content-Length)   (stdin/stdout)
"""

from __future__ import annotations

import asyncio
import shutil
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any, Dict, List

from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from utils.logger import logger


class MCPClient:
    """
    单个 MCP Server 的异步客户端

    生命周期:
        client = MCPClient(name="amap")
        await client.start(command="npx", args=[...], env={...})
        result = await client.call_tool("maps_geo", {"address": "北京"})
        await client.stop()

    与 test/mcp/transport.py 的区别:
        - 集成了 EmaAgent 的 logger
        - name 字段用于日志标识（多 Server 场景）
        - 返回值格式保持一致: {"content": [...], "isError": bool}
    """

    def __init__(self, name: str = "mcp") -> None:
        """
        Args:
            name: 此 MCP Server 的标识名（用于日志区分）
        """
        self.name = name
        self._stack: AsyncExitStack | None = None
        self._session: ClientSession | None = None
        self.tools: List[Dict[str, Any]] = []
        self.server_info: Dict[str, Any] = {}

    @property
    def is_connected(self) -> bool:
        """当前是否已连接"""
        return self._session is not None

    # ── 生命周期 ────────────────────────────────────────────────────

    async def start(
        self,
        command: str,
        args: List[str],
        env: Dict[str, str] | None = None,
        cwd: str | None = None,
    ) -> Dict[str, Any]:
        """
        启动 MCP Server 子进程 + 握手 + 缓存工具列表

        Args:
            command: 可执行文件路径 (如 npx, python 等)
            args:    命令行参数
            env:     环境变量 (会完整替代子进程的 env)
            cwd:     工作目录

        Returns:
            initialize 返回的 result dict (含 serverInfo, capabilities)

        Raises:
            RuntimeError: 启动失败时
        """
        logger.info(f"[MCP:{self.name}] 启动 Server: {command} {' '.join(args)}")
        # 使用 AsyncExitStack 管理子进程和会话的生命周期
        self._stack = AsyncExitStack()
        # 构造 Server 参数
        server_params = StdioServerParameters(
            command=command,
            args=args,
            env=env,
            cwd=cwd or str(Path.cwd()),
            encoding="utf-8",
            encoding_error_handler="replace",
        )

        # 拉起子进程 + stdio 管道
        read_stream, write_stream = await self._stack.enter_async_context(
            stdio_client(server_params)
        )

        # JSON-RPC 会话
        self._session = await self._stack.enter_async_context(
            ClientSession(read_stream, write_stream)
        )

        # 握手
        init_result = await self._session.initialize()
        init_data = _to_dict(init_result)
        self.server_info = init_data.get("serverInfo", {})

        server_name = self.server_info.get("name", "unknown")
        logger.info(f"✅️[MCP:{self.name}] 握手完成: {server_name}")

        # 缓存工具列表
        await self.refresh_tools()

        return init_data

    async def stop(self) -> None:
        """关闭 session + 终止子进程"""
        stack = self._stack
        if not stack:
            return

        # 先摘引用，避免并发/重复 stop 导致二次关闭
        self._stack = None
        self._session = None

        logger.info(f"✅️[MCP:{self.name}] 关闭连接")
        try:
            # 在原任务中直接关闭，避免 shield 触发跨任务退出 cancel scope。
            await stack.aclose()
        except asyncio.CancelledError as e:
            # Ctrl+C 触发 shutdown 时，底层 anyio 可能抛出取消异常，这里吞掉避免中断整体退出流程
            logger.warning(f"[MCP:{self.name}] 关闭被取消: {e}")
        except BaseException as e:
            # Python 3.11 下 anyio 可能抛出 BaseExceptionGroup（不属于 Exception）。
            text = str(e)
            if "cancel scope" in text.lower():
                logger.warning(f"[MCP:{self.name}] 忽略关闭阶段 cancel scope 异常: {text}")
            else:
                logger.warning(f"[MCP:{self.name}] 关闭时 BaseException: {text}")
        except Exception as e:
            logger.warning(f"[MCP:{self.name}] 关闭时异常: {e}")

    # ── 工具操作 ────────────────────────────────────────────────────

    async def refresh_tools(self) -> List[Dict[str, Any]]:
        """重新获取 Server 的 Tool 列表"""
        if not self._session:
            raise RuntimeError(f"❌️[MCP:{self.name}] Server 未启动")

        result = await self._session.list_tools()
        raw = _to_dict(result)
        self.tools = list(raw.get("tools") or [])

        tool_names = [t.get("name", "?") for t in self.tools]
        logger.info(f"[MCP:{self.name}] 可用工具 ({len(self.tools)}): {', '.join(tool_names)}")

        return self.tools

    async def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """
        调用指定 Tool

        Args:
            name:      工具名称
            arguments: 工具参数 dict

        Returns:
            MCP 标准结果: {"content": [...], "isError": bool}

        Raises:
            RuntimeError: Server 未启动
        """
        if not self._session:
            raise RuntimeError(f"[MCP:{self.name}] Server 未启动")

        logger.debug(f"[MCP:{self.name}] call_tool: {name}")
        result = await self._session.call_tool(name, arguments)
        return _to_dict(result)

    # ── 格式转换 ────────────────────────────────────────────────────

    def tools_to_openai_format(self) -> List[Dict[str, Any]]:
        """
        MCP Tool 列表 → OpenAI function calling 格式

        MCP:    {"name", "description", "inputSchema"}
        OpenAI: {"type": "function", "function": {"name", "description", "parameters"}}
        """
        return [
            {
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "parameters": t.get("inputSchema", {"type": "object", "properties": {}}),
                },
            }
            for t in self.tools
        ]


# ════════════════════════════════════════════════════════════════════
#  辅助函数
# ════════════════════════════════════════════════════════════════════


def _to_dict(obj: Any) -> Dict[str, Any]:
    """将 mcp SDK 返回的 Pydantic 对象转为普通 dict"""
    if hasattr(obj, "model_dump"):
        try:
            return obj.model_dump(by_alias=True, exclude_none=True)
        except Exception:
            return obj.model_dump()
    if isinstance(obj, dict):
        return obj
    return {}


def resolve_npx() -> str:
    """
    解析 npx 可执行路径

    Windows 上 npx 实际是 npx.cmd，需要特殊处理
    """
    for name in ("npx", "npx.cmd"):
        path = shutil.which(name)
        if path:
            return path
    raise RuntimeError(
        "找不到 npx 命令，请先安装 Node.js（含 npm / npx）\n"
        "  Windows: winget install OpenJS.NodeJS.LTS\n"
        "  或访问: https://nodejs.org/"
    )
