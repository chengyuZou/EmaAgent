"""
MCPManager — 多 MCP Server 生命周期管理器

职责:
    1. 从配置文件读取 MCP Server 列表
    2. 启动/停止所有 Server 的子进程
    3. 为每个 Server 的工具创建 MCPToolBridge
    4. 提供统一的工具注入接口

配置格式 (config/config.json 中的 mcp_servers 字段):

    "mcp_servers": {
        "amap": {
            "enabled": true,
            "command": "npx",
            "args": ["-y", "@amap/amap-maps-mcp-server"],
            "env": {
                "AMAP_MAPS_API_KEY": "${AMAP_MAPS_API_KEY}"
            },
            "description": "高德地图 MCP 服务"
        },
        "filesystem": {
            "enabled": false,
            "command": "npx",
            "args": ["-y", "@anthropic/mcp-filesystem-server", "/path/to/dir"],
            "description": "Anthropic 文件系统 MCP 服务"
        }
    }

env 中的 ${VAR_NAME} 会被自动替换为对应的环境变量值。

生命周期:

    ┌─────────┐  start_all()  ┌───────────┐  get_all_tools()  ┌──────────────┐
    │ config  │ ────────────► │ MCPClient │ ───────────────► │ MCPToolBridge│
    │ .json   │               │  × N 个    │                   │   × M 个     │
    └─────────┘               └───────────┘                   └──────────────┘
                                    │                               │
                              stop_all()                    add_tools(*bridges)
                                    │                               │
                                    ▼                               ▼
                              子进程全部关闭                  ToolCollection
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional


from .bridge import MCPToolBridge
from .client import MCPClient, resolve_npx

from utils.logger import logger


class MCPManager:
    """
    多 MCP Server 管理器

    用法:
    ```python
        manager = MCPManager(config, project_root)
        await manager.start_all()
        tools = manager.get_all_tools()     # list[MCPToolBridge]
        agent.tools.add_tools(*tools)

        # 应用关闭时
        await manager.stop_all()
    ```
    """

    def __init__(
        self,
        mcp_config: Dict[str, Any],
        project_root: Optional[str] = None,
    ) -> None:
        """
        Args:
            mcp_config:   config.json 中 "mcp_servers" 字段的值
                          格式: {"server_name": {"command", "args", "env", "enabled"}}
            project_root: 项目根目录（用作子进程 cwd）
        """
        self._config = mcp_config or {}
        self._project_root = project_root or str(Path.cwd())
        self._clients: Dict[str, MCPClient] = {}
        self._bridges: List[MCPToolBridge] = []

    @property
    def clients(self) -> Dict[str, MCPClient]:
        """已启动的 MCPClient 字典 {name: client}"""
        return dict(self._clients)

    @property
    def tools(self) -> List[MCPToolBridge]:
        """所有已创建的 MCPToolBridge 列表"""
        return list(self._bridges)

    # ── 生命周期 ────────────────────────────────────────────────────

    async def start_all(self) -> List[MCPToolBridge]:
        """
        启动所有 enabled 的 MCP Server 并创建工具桥接

        Returns:
            所有 MCPToolBridge 实例列表

        注意:
            单个 Server 启动失败不会影响其他 Server。
            失败的 Server 会被跳过并记录错误日志。
        """
        self._bridges.clear()

        if not self._config:
            logger.info("[MCPManager] 无 MCP Server 配置，跳过")
            return []

        enabled_servers: Dict[str, Dict[str, Any]] = {}
        for name, cfg in self._config.items():
            if not isinstance(cfg, dict):
                logger.warning(f"[MCPManager] 跳过无效配置项: {name}")
                continue
            if not cfg.get("enabled", True):
                continue

            # 当前实现仅支持 stdio(command/args) 类型 MCP。
            command = str(cfg.get("command", "")).strip()
            if not command:
                if str(cfg.get("url", "")).strip():
                    logger.warning(f"[MCPManager] {name} 为 URL 类型 MCP，当前版本暂不支持启动，已跳过")
                else:
                    logger.warning(f"[MCPManager] {name} 缺少 command 字段，已跳过")
                continue

            enabled_servers[name] = cfg

        if not enabled_servers:
            logger.info("[MCPManager] 所有 MCP Server 均已禁用，跳过")
            return []

        logger.info(f"[MCPManager] 即将启动 {len(enabled_servers)} 个 MCP Server: {list(enabled_servers.keys())}")

        for name, cfg in enabled_servers.items():
            try:
                client = await self._start_one(name, cfg)
                self._clients[name] = client

                # 为该 Server 的每个工具创建 Bridge
                bridges = MCPToolBridge.from_mcp_client(client)
                self._bridges.extend(bridges)

            except Exception as e:
                logger.error(f"[MCPManager] 启动 {name} 失败: {e}", exc_info=True)
                # 继续启动其他 Server

        logger.info(
            f"[MCPManager] 启动完成: "
            f"{len(self._clients)}/{len(enabled_servers)} Server, "
            f"{len(self._bridges)} 个工具"
        )

        return list(self._bridges)

    async def stop_all(self) -> None:
        """停止所有已启动的 MCP Server"""
        if not self._clients:
            return

        logger.info(f"[MCPManager] 正在停止 {len(self._clients)} 个 MCP Server...")

        for name, client in list(self._clients.items()):
            try:
                await client.stop()
                logger.info(f"[MCPManager] {name} 已停止")
            except asyncio.CancelledError as e:
                logger.warning(f"[MCPManager] 停止 {name} 时被取消: {e}")
            except BaseException as e:
                logger.warning(f"[MCPManager] 停止 {name} 时 BaseException: {e}")
            except Exception as e:
                logger.warning(f"[MCPManager] 停止 {name} 时异常: {e}")

        self._clients.clear()
        self._bridges.clear()

    async def restart_all(self) -> List[MCPToolBridge]:
        """重启所有 MCP Server"""
        await self.stop_all()
        return await self.start_all()

    # ── 单 Server 操作 ─────────────────────────────────────────────

    async def start_one(self, name: str) -> List[MCPToolBridge]:
        """
        启动单个 MCP Server（需要在 config 中已声明）

        Args:
            name: Server 名称

        Returns:
            该 Server 对应的 MCPToolBridge 列表
        """
        cfg = self._config.get(name)
        if not cfg:
            raise ValueError(f"MCP Server '{name}' 未在配置中声明")

        # 如果已启动，先停止
        if name in self._clients:
            await self._clients[name].stop()
            # 移除旧的 bridges
            self._bridges = [b for b in self._bridges if b._server_name != name]

        client = await self._start_one(name, cfg)
        self._clients[name] = client

        bridges = MCPToolBridge.from_mcp_client(client)
        self._bridges.extend(bridges)

        return bridges

    async def stop_one(self, name: str) -> None:
        """停止单个 MCP Server"""
        client = self._clients.pop(name, None)
        if client:
            try:
                await client.stop()
            except asyncio.CancelledError as e:
                logger.warning(f"[MCPManager] 停止 {name} 时被取消: {e}")
            except BaseException as e:
                logger.warning(f"[MCPManager] 停止 {name} 时 BaseException: {e}")
            self._bridges = [b for b in self._bridges if b._server_name != name]

    # ── 工具访问 ────────────────────────────────────────────────────

    def get_all_tools(self) -> List[MCPToolBridge]:
        """获取所有 MCP 工具的 Bridge 列表"""
        return list(self._bridges)

    def get_tools_by_server(self, name: str) -> List[MCPToolBridge]:
        """获取指定 Server 的工具列表"""
        return [b for b in self._bridges if b._server_name == name]

    # ── 内部方法 ────────────────────────────────────────────────────

    async def _start_one(self, name: str, cfg: Dict[str, Any]) -> MCPClient:
        """
        内部: 启动单个 MCP Server

        处理:
          1. 解析 command (自动处理 npx 路径)
          2. 展开 env 中的 ${VAR} 引用
          3. 创建 MCPClient 并启动
        """
        command = str(cfg.get("command", "")).strip()
        args = cfg.get("args", [])
        env_template = cfg.get("env", {})
        cwd = cfg.get("cwd", self._project_root)

        if not command:
            raise ValueError(f"MCP Server '{name}' 缺少 command 字段")

        # 自动解析 npx 路径
        if command in ("npx", "npx.cmd"):
            command = resolve_npx()

        # 展开环境变量模板: ${VAR_NAME} → os.environ[VAR_NAME]
        env = _expand_env(env_template)

        client = MCPClient(name=name)
        await client.start(
            command=command,
            args=args,
            env=env,
            cwd=cwd,
        )

        return client


# ════════════════════════════════════════════════════════════════════
#  辅助函数
# ════════════════════════════════════════════════════════════════════

# 替换辅助常量与 _expand_env（兼容旧 ${VAR} + 新 VAR 写法）

# 匹配 ${VAR_NAME} 模板变量（旧格式）
_ENV_VAR_PATTERN = re.compile(r"\$\{([^}]+)\}")
# 匹配 ENV_NAME（新格式）
_ENV_NAME_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]*$")

def _looks_like_env_name(value: str) -> bool:
    """
    判断文本是否像环境变量名。

    Args:
        value (str): 待判断文本。

    Returns:
        bool: 是否为环境变量名。
    """
    return bool(_ENV_NAME_PATTERN.fullmatch(str(value or "").strip()))

def _resolve_env_name(config_key: str, raw_value: str) -> str:
    """
    从 env 模板值中提取环境变量名。

    支持：
    1. "${ENV_NAME}"（旧格式）
    2. "ENV_NAME"（新格式）
    3. "KEY" 且与 config_key 同名（兼容写法）

    Args:
        config_key (str): env 字典中的键名。
        raw_value (str): env 字典中的原始值。

    Returns:
        str: 解析出的环境变量名；若为空表示字面值。
    """
    # 先判断是否为空
    text = str(raw_value or "").strip()
    if not text:
        return ""
    
    # 1. "${ENV_NAME}" 模式
    match = _ENV_VAR_PATTERN.fullmatch(text)
    if match:
        return match.group(1).strip()
    
    # 2. "ENV_NAME" 模式
    if _looks_like_env_name(text):
        return text

    # 3. 兼容写法：KEY 与 value 同名 或直接取Key的名字（如 "AMAP_MAPS_API_KEY": "AMAP_MAPS_API_KEY"）
    if config_key == text:
        return text
    elif _looks_like_env_name(config_key):
        return config_key
    
    # 4. 其他情况按字面值处理（不返回环境变量名）
    return ""

def _expand_env(env_template: Dict[str, str]) -> Dict[str, str]:
    """
    展开 MCP env 配置。

    支持以下三类值：
    1. "${ENV_NAME}"：读取对应环境变量
    2. "ENV_NAME"：读取对应环境变量（推荐）
    3. "literal-value"：按字面值透传

    Args:
        env_template (Dict[str, str]): MCP server 的 env 模板配置。

    Returns:
        Dict[str, str]: 可直接传入子进程的完整环境变量映射。
    """
    # 以当前进程环境为基础
    result = dict(os.environ)

    for key, value in env_template.items():
        if not isinstance(value, str):
            result[key] = str(value)
            continue

        env_name = _resolve_env_name(key, value)
        if env_name:
            env_value = os.environ.get(env_name, "")
            if not env_value:
                logger.warning(f"[MCPManager] 环境变量 '{env_name}' 未设置，使用空值")
            result[key] = env_value
        else:
            # 按字面值透传
            result[key] = value
    return result
