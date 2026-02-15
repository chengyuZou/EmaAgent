"""
上下文压缩器模块

该模块负责在消息数量增长后 将历史对话压缩为可继续注入上下文的摘要文本
用于降低上下文长度并保留关键记忆信息
"""

from __future__ import annotations

from typing import List, Optional

from llm.client import LLMClient
from memory.schema import Message
from utils.logger import logger

COMPRESSION_PROMPT = """
你是艾玛的记忆压缩助手。
请将以下对话历史压缩为简洁的摘要，保留关键信息：

要求：
1. 提取主要讨论的话题和结论
2. 如果涉及工具调用，保留工具名称、操作对象和结果
3. 如果涉及文件操作，保留文件路径和操作类型
4. 以艾玛的身份,要体现出压缩的文本是从她的记忆中提取的

## 现有摘要
{existing_summary}

## 新的对话内容
{messages}

## 输出格式
请直接输出压缩后的摘要，不要加任何前缀或解释。
"""


class Compressor:
    """
    智能上下文压缩器

    该类通过 LLM 将历史消息压缩为摘要 并提供失败时的本地回退压缩逻辑

    用于在长会话中控制上下文规模

    Args:
        llm_client (Optional[LLMClient]): 用于压缩的 LLM 客户端实例
        compress_threshold (int): 触发压缩的消息数量阈值
        keep_recent_turns (int): 压缩时保留的最近对话轮数

    Returns:
        Compressor: 压缩器实例对象
    """

    def __init__(
        self,
        llm_client: Optional[LLMClient] = None,  # LLM 客户端
        compress_threshold: int = 30,  # 消息数超过此值触发压缩
        keep_recent_turns: int = 5,  # 保留最近 N 轮对话
    ):
        """
        初始化压缩器配置

        该构造函数仅保存运行参数 不执行网络请求

        Args:
            llm_client (Optional[LLMClient]): 用于压缩的 LLM 客户端实例
            compress_threshold (int): 触发压缩的消息数量阈值
            keep_recent_turns (int): 压缩时保留的最近对话轮数
        """
        # 保存依赖与策略参数 供后续压缩流程使用
        self.llm_client = llm_client
        self.compress_threshold = compress_threshold
        self.keep_recent_turns = keep_recent_turns

    async def compress(
        self,
        messages: List[Message],
        existing_summary: str = ""
    ) -> str:
        """
        压缩一组对话消息并返回摘要

        方法会先将消息格式化为压缩输入 再调用 LLM 生成摘要

        若调用失败则回退到本地简化摘要方案

        Args:
            messages (List[Message]): 待压缩的消息列表
            existing_summary (str): 已有摘要文本 (可选) 用于增量压缩时提供上下文

        Returns:
            str: 压缩后的摘要文本

        Raises:
            Exception: 当 LLM 压缩失败且回退逻辑也无法执行时抛出异常

        Examples:
            >>> await compressor.compress(messages, existing_summary="")
        """
        # 空输入直接返回已有摘要 避免无意义请求
        if not messages:
            return existing_summary

        # 将消息转换为更紧凑、可压缩的文本格式
        formatted_messages = self._format_messages(messages)

        # 构造最终提示词 注入旧摘要与当前消息块
        prompt = COMPRESSION_PROMPT.format(
            existing_summary=existing_summary or "(无)",
            messages=formatted_messages
        )

        try:
            # 使用低温度压缩 减少随机性并提升摘要稳定度
            summary = await self.llm_client.chat(
                messages=[{"role": "user", "content": prompt}],
                stream=False,
                temperature=0.3,  # 低温度 保证输出稳定
                max_tokens=500
            )

            logger.info(f"📦 压缩完成: {len(messages)} 条消息 → {len(summary)} 字符")
            return summary.strip()

        except Exception as e:
            logger.error(f"❌ 压缩失败: {e}")
            # LLM 失败时 回退到本地规则压缩以保持流程可用
            return self._fallback_compress(messages, existing_summary)

    def _format_messages(self, messages: List[Message]) -> str:
        """
        将消息列表格式化为压缩输入文本

        该方法会将角色映射为可读标签 并截断过长内容

        以控制提示词长度并保留主要语义

        Args:
            messages (List[Message]): 原始消息列表

        Returns:
            str: 格式化后的文本字符串

        Examples:
            >>> text = compressor._format_messages(messages)
        """
        lines = []
        for msg in messages:
            # 将内部 role 转为更易读的显示名称
            role_name = {
                "user": "用户",
                "assistant": "艾玛",
                "system": "系统",
                "tool": "工具"
            }.get(msg.role, msg.role)

            # 对超长内容做截断 避免单条消息占用过多 token
            content = msg.content
            if len(content) > 1000:
                content = content[:1000] + "..."

            lines.append(f"[{role_name}]: {content}")

        return "\n".join(lines)

    def _fallback_compress(
        self,
        messages: List[Message],
        existing_summary: str
    ) -> str:
        """
        执行回退压缩逻辑

        当 LLM 压缩失败时 该方法会基于用户消息构造一个简化摘要

        用于保证会话流程不中断

        Args:
            messages (List[Message]): 原始消息列表
            existing_summary (str): 已有摘要文本 用于增量压缩时提供上下文

        Returns:
            str: 回退压缩后的摘要文本

        Examples:
            >>> text = compressor._fallback_compress(messages, "")
        """
        # 回退策略只聚焦用户输入 提取主题片段
        user_messages = [m.content for m in messages if m.role == "user"]

        if not user_messages:
            return existing_summary

        # 合并前若干条用户消息 避免摘要过长
        simple_summary = "用户讨论了以下话题：" + "、".join(
            msg[:100] + "..." if len(msg) > 100 else msg
            for msg in user_messages[:10]
        )

        # 若已有摘要则追加增量摘要 否则直接返回新摘要
        if existing_summary:
            return f"{existing_summary}\n\n{simple_summary}"
        return simple_summary
