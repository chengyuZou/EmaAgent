"""
Memory 模块 - 会话管理

结构：
- schema.py: 数据模型（Session, Message, CompressionHistory）
- manager.py: 会话管理器（CRUD 操作）
- compressor.py: 上下文压缩器（LLM 智能压缩）

存储结构：
sessions/
└── {session_id}/
    ├── session.json        # 会话元信息
    ├── messages.json       # 完整对话历史
    └── compression.json    # 压缩记录
"""
from memory.schema import (
    Session,
    Message,
    UserMessage,
    AssistantMessage,
    ToolMessage,
    SystemMessage,
    CompressionRecord,
    CompressionHistory,
    AgentStatus,
    AgentRuntimeState,
)
from memory.manager import SessionManager
from memory.compressor import Compressor

__all__ = [
    # 数据模型
    "Session",
    "Message",
    "UserMessage",
    "AssistantMessage",
    "ToolMessage",
    "SystemMessage",
    "CompressionRecord",
    "CompressionHistory",
    "AgentStatus",
    "AgentRuntimeState",
    # 管理器
    "SessionManager",
    "Compressor",
]