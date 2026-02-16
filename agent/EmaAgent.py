"""
EmaAgent 主入口模块

该模块负责组合 LLM ReAct Narrative TTS 与会话服务
并向外提供普通调用与流式调用两套接口
"""
import asyncio
from datetime import datetime
from typing import Optional, TYPE_CHECKING, List, Dict, Any, Callable, Awaitable

from agent.react import ReActAgent
from llm.client import LLMClient
from llm.config import LLMConfig
from memory.compressor import Compressor
from memory.schema import AssistantMessage, AgentRuntimeState, Session, UserMessage
from narrative.core import NarrativeMemory
from prompts import PERSONA_PROFILE_PROMPT, STORY_SUMMARY_PROMPT
from utils.logger import logger

from api.services.live2d_service import get_live2d_service, EmaEmotion

if TYPE_CHECKING:
    from config.paths import PathConfig


VALID_MODES = {"chat", "agent", "narrative", "finish"}


MAX_ATTACHMENT_EXCERPT_CHARS = 12000
MAX_MERGED_INPUT_CHARS = 20000
MAX_SINGLE_MESSAGE_CHARS = 32000
MAX_TOTAL_CONTEXT_CHARS = 180000


class EmaAgent:
    """
    EmaAgent 总调度器

    该类用于统一管理配置 会话 记忆 推理与语音相关组件
    对外提供 run 与 run_stream 作为核心调用入口
    """

    def __init__(self, server_mode: bool = False):
        """
        初始化代理实例

        该方法会初始化配置缓存与并发锁 并构建核心组件

        Args:
            server_mode (bool): 是否启用服务模式 服务模式下不初始化本地 TTS
        """
        self._server_mode = server_mode
        self._config_cache: Optional[Dict[str, Any]] = None
        self._config_version = 0
        # narrative 组件可能涉及较重的资源加载 因此采用懒加载方式 并使用锁保护初始化过程 防止并发请求导致重复初始化
        self._narrative_init_lock = asyncio.Lock()
        self._init_components()

    @property
    def paths(self) -> "PathConfig":
        """
        获取路径配置对象

        Returns:
            PathConfig: 全局路径配置实例
        """
        from config.paths import get_paths

        return get_paths()

    @property
    def config(self) -> Dict[str, Any]:
        """
        获取缓存后的运行配置

        Returns:
            Dict[str, Any]: 当前生效配置字典
        """
        if self._config_cache is None:
            self._load_config()
        return self._config_cache or {}

    @property
    def session_service(self):
        """
        获取会话服务实例

        Returns:
            Any: 会话服务对象 提供会话读写能力
        """
        from api.services.session_service import get_session_service

        return get_session_service()

    def _load_config(self):
        """
        重新加载配置缓存
        """
        self._config_cache = self.paths.load_config()
        self._config_version += 1

    def _init_components(self):
        """
        初始化全部核心组件

        包括 LLM ReAct 压缩器 可选 TTS Narrative 与 Live2D 服务
        """
        self._load_config()

        # 从配置缓存与路径设置中构建 LLM 配置对象 并初始化 LLM 客户端 
        self.llm_config = LLMConfig.from_runtime(self._config_cache or {}, self.paths.load_settings())
        self.llm_client = LLMClient(config=self.llm_config)
        self.tts_config = (self._config_cache or {}).get("tts", {})

        # 初始化 ReAct Agent 与文本压缩器 这两个组件在 agent 模式与 narrative 模式下都会用到
        self.agent = ReActAgent(llm_client=self.llm_client, max_steps=20)
        self.compressor = Compressor(llm_client=self.llm_client)

        """
        根据是否启用服务模式决定是否初始化 TTS 管理器
        2026.1.20之前,EmaAgent 只能在终端上跑, 因此默认启用 TTS 管理器 
        但现在需要兼容服务端部署 因此不再使用Manager 
        并增加了 server_mode 参数 在api文件夹下 控制是否初始化 TTS 管理器
        """
        if not self._server_mode:
            from audio.tts_manager import TTSManager
            self.tts_manager = TTSManager(
                api_key=self.tts_config.get("api_key", ""),
                output_dir=str(self.paths.audio_output_dir),
                reference_audio_path=str(self.paths.default_reference_audio),
                reference_text=self.tts_config.get("reference_text", ""),
            )
        else:
            self.tts_manager = None

        self.narrative: Optional[NarrativeMemory] = None
        self.system_prompt = PERSONA_PROFILE_PROMPT
        self.live2d_service = get_live2d_service()

    def reload_config(self):
        """
        对外暴露的配置重载入口
        """
        logger.info("重载 agent config...")
        self._config_cache = None
        self._init_components()
        logger.info("Agent config reloaded.")

    async def initialize_narrative(self):
        """
        懒加载 Narrative 记忆组件

        该方法带并发锁 防止并发请求重复初始化
        """
        # 双重检查锁定模式 避免不必要的锁竞争
        if self.narrative is not None:
            return
        # 获取锁后再次检查 narrative 是否已被其他协程初始化 避免重复初始化导致资源浪费
        async with self._narrative_init_lock:
            if self.narrative is not None:
                return
            # 将路径配置中的 timeline_dirs 转换为字符串路径字典 以兼容 NarrativeMemory 的初始化要求
            timeline_dirs = {k: str(v) for k, v in self.paths.timeline_dirs.items()}
            # 初始化 NarrativeMemory 组件 该组件会加载剧情相关的记忆数据 并提供查询接口 以支持 narrative 模式下的剧情回顾功能
            self.narrative = NarrativeMemory(
                llm_client=self.llm_client,
                timeline_dirs=timeline_dirs,
                summary_text=STORY_SUMMARY_PROMPT,
            )
            await self.narrative.initialize()
            logger.info("剧情记忆组件初始化完成")

    def _normalize_mode(self, mode: Optional[str]) -> str:
        """
        规范化 mode 输入值

        非法 mode 会自动回退到 chat

        主要用在前端的`chat`界面, 该界面会传入 mode 参数 来控制是普通聊天 还是 agent 模式 还是 narrative 模式

        之前的版本(2026.2 之前)是 再添加一个用LLMClient封装的`Router`路由器 就在llm文件夹下 对用户输入的`Query`进行分类 以决定后续的处理流程 
        
        但现在改为前端直接传入 mode 参数 以简化后端逻辑 并防止误分类导致的处理错误 

        Args:
            mode (Optional[str]): 原始模式字符串

        Returns:
            str: 规范后的模式值
        """
        value = (mode or "chat").strip().lower()
        if value not in VALID_MODES:
            return "chat"
        return value

    def _compose_user_input(self, user_input: str, attachments: Optional[List[Dict[str, Any]]]) -> str:
        """
        合并用户输入与附件描述文本(前端点击上传附件)

        当存在附件时 会生成统一结构文本并拼接到用户输入后

        Args:
            user_input (str): 用户原始输入
            attachments (Optional[List[Dict[str, Any]]]): 附件元数据列表

        Returns:
            str: 合并后的输入文本
        """
        # 基础文本为用户输入的纯文本部分 去除首尾空白 如果没有输入 则默认为空字符串
        base_text = (user_input or "").strip()
        if not attachments:
            return base_text
        
        # 遍历附件列表 构建每个附件的描述文本
        # 恢复为将附件提取文本写入历史消息 便于重开页面后保持可见
        lines: List[str] = []
        for index, item in enumerate(attachments, start=1):
            name = item.get("name", f"file_{index}")
            content_type = item.get("content_type", "application/octet-stream")
            size = item.get("size", 0)
            saved_path = item.get("saved_path", "")
            text_excerpt = str(item.get("text_excerpt", "") or "").strip()

            line = f"{index}. {name} ({content_type}, {size} bytes)"
            if saved_path:
                line += f"\npath: {saved_path}"
            if text_excerpt:
                excerpt = self._truncate_text(text_excerpt, MAX_ATTACHMENT_EXCERPT_CHARS)
                line += f"\ncontent:\n{excerpt}"
            lines.append(line)

        attachment_block = "[User Attachments]\n" + "\n\n".join(lines)
        attachment_block = self._truncate_text(attachment_block, MAX_ATTACHMENT_EXCERPT_CHARS)
        if base_text:
            merged = f"{base_text}\n\n{attachment_block}"
        else:
            merged = attachment_block
        return self._truncate_text(merged, MAX_MERGED_INPUT_CHARS)

    def _truncate_text(self, text: str, limit: int) -> str:
        """
        以字符数限制文本长度 超长时保留前后关键片段
        """
        if limit <= 0:
            return ""
        if len(text) <= limit:
            return text

        head_len = max(limit // 2, 1)
        tail_len = max(limit - head_len, 1)
        omitted = len(text) - (head_len + tail_len)
        return (
            f"{text[:head_len]}\n\n"
            f"[...已截断 {omitted} 个字符...]\n\n"
            f"{text[-tail_len:]}"
        )

    async def run(
        self,
        user_input: str,
        session_id: str = "default",
        mode: Optional[str] = None,
        attachments: Optional[List[Dict[str, Any]]] = None,
    ) -> dict:
        """
        同步式完整调用入口

        该方法在内部完成会话压缩 模式分发 文本生成 TTS 与保存

        Args:
            user_input (str): 用户输入文本
            session_id (str): 会话标识
            mode (Optional[str]): 执行模式 chat agent narrative finish
            attachments (Optional[List[Dict[str, Any]]]): 附件信息列表

        Returns:
            dict: 包含 intent answer duration session_id stopped
        """
        # 记录调用开始时间 以便后续计算总耗时 这对于性能监控和用户体验优化非常重要
        start_time = datetime.now()
        # 根据 session_id 获取或创建会话对象
        session = self.session_service.get_or_create_session(session_id)

        # 在处理用户输入之前 先检查当前会话上下文是否过大 如果超过预设限制 则调用压缩器进行压缩
        compressed = await session.compress_if_needed(self.compressor)
        if compressed:
            logger.info("在处理 run() 之前上下文已被压缩。")

        # 选择执行模式
        intent = self._normalize_mode(mode)
        # 合并用户上传的附件
        merged_input = self._compose_user_input(user_input, attachments)

        await self._set_emotion_by_intent(intent)

        if self.tts_manager:
            self.tts_manager.reset()

        if intent == "narrative":
            answer = await self._handle_narrative(session, merged_input)
        elif intent == "agent":
            answer = await self._handle_agent(session, merged_input)
        elif intent == "finish":
            answer = "再见呀！期待下次见面~"
            session.add_message(UserMessage(content=merged_input))
            session.add_message(AssistantMessage(content=answer))
            await self._speak(answer)
        else:
            answer = await self._handle_chat(session, merged_input)

        # 每次调用结束后 将 total_runs 计数器加1 并保存会话状态 以便后续分析和监控
        session.total_runs += 1
        self.session_service.save_session(session)

        duration = (datetime.now() - start_time).total_seconds()
        await self._analyze_and_set_emotion(answer)
        return {
            "intent": intent,
            "answer": answer,
            "duration": duration,
            "session_id": session.session_id,
            "stopped": False,
        }

    async def run_stream(
        self,
        user_input: str,
        session_id: str = "default",
        mode: Optional[str] = None,
        attachments: Optional[List[Dict[str, Any]]] = None,
        on_token: Optional[Callable[[str], Awaitable[None]]] = None,
        should_stop: Optional[Callable[[], bool]] = None,
    ) -> dict:
        """
        流式调用入口

        该方法逐 token 回调并在结束后返回完整结果

        Args:
            user_input (str): 用户输入文本
            session_id (str): 会话标识
            mode (Optional[str]): 执行模式 chat agent narrative finish
            attachments (Optional[List[Dict[str, Any]]]): 附件信息列表
            on_token (Optional[Callable[[str], Awaitable[None]]]): token 回调函数
            should_stop (Optional[Callable[[], bool]]): 外部中断判定函数

        Returns:
            dict: 包含 intent answer duration session_id stopped
        """
        # 记录调用开始时间 以便后续计算总耗时 这对于性能监控和用户体验优化非常重要
        start_time = datetime.now()
        # 根据 session_id 获取或创建会话对象
        session = self.session_service.get_or_create_session(session_id)

        # 在处理用户输入之前 先检查当前会话上下文是否过大 如果超过预设限制 则调用压缩器进行压缩
        compressed = await session.compress_if_needed(self.compressor)
        if compressed:
            logger.info("在处理 run_stream() 之前上下文已被压缩。")

        # 选择执行模式
        intent = self._normalize_mode(mode)
        # 合并用户上传的附件
        merged_input = self._compose_user_input(user_input, attachments)

        await self._set_emotion_by_intent(intent)

        # 根据不同模式调用对应的处理函数 这些函数内部会使用 on_token 回调逐 token 返回生成结果 
        # 同时接受 should_stop 函数以支持外部中断生成过程
        stopped = False
        if intent == "narrative":
            answer, stopped = await self._handle_narrative_stream(
                session, merged_input, on_token=on_token, should_stop=should_stop
            )
        elif intent == "agent":
            answer, stopped = await self._handle_agent_stream(
                session, merged_input, on_token=on_token, should_stop=should_stop
            )
        elif intent == "finish":
            answer = "再见呀！期待下次见面~"
            session.add_message(UserMessage(content=merged_input))
            session.add_message(AssistantMessage(content=answer))
            if on_token:
                result = on_token(answer)
                if asyncio.iscoroutine(result):
                    await result
        else:
            answer, stopped = await self._handle_chat_stream(
                session,
                merged_input,
                on_token=on_token,
                should_stop=should_stop,
            )

        session.total_runs += 1
        self.session_service.save_session(session)

        duration = (datetime.now() - start_time).total_seconds()
        if answer:
            await self._analyze_and_set_emotion(answer)
        return {
            "intent": intent,
            "answer": answer,
            "duration": duration,
            "session_id": session.session_id,
            "stopped": stopped,
        }

    async def _set_emotion_by_intent(self, intent: str):
        """
        根据模式设置基础情绪

        Args:
            intent (str): 当前执行模式

        Returns:
            None
        """
        # 根据不同的模式设置不同的基础情绪 narrative 和 agent 模式保持正常 chat 模式设置为开心 finish 模式设置为伤心 以增强用户体验
        emotion_map = {
            "narrative": EmaEmotion.NORMAL,
            "agent": EmaEmotion.NORMAL,
            "chat": EmaEmotion.HAPPY,
            "finish": EmaEmotion.SAD,
        }
        self.live2d_service.set_emotion(emotion_map.get(intent, EmaEmotion.NORMAL))

    async def _analyze_and_set_emotion(self, text: str):
        """
        根据文本关键词调整情绪

        Args:
            text (str): 生成回复文本

        Returns:
            None
        """
        if any(word in text for word in ["开心", "高兴", "太好了", "哈哈", "嘿嘿"]):
            self.live2d_service.set_emotion(EmaEmotion.HAPPY)
        elif any(word in text for word in ["难过", "伤心", "抱歉", "对不起"]):
            self.live2d_service.set_emotion(EmaEmotion.SAD)
        elif any(word in text for word in ["生气", "讨厌", "可恶"]):
            self.live2d_service.set_emotion(EmaEmotion.ANGRY)
        elif any(word in text for word in ["哇", "真的吗", "惊讶"]):
            self.live2d_service.set_emotion(EmaEmotion.SURPRISED)
        elif any(word in text for word in ["害羞", "不好意思"]):
            self.live2d_service.set_emotion(EmaEmotion.SHY)

    async def _handle_narrative(self, session: Session, query: str) -> str:
        """
        处理 narrative 模式非流式请求

        Args:
            session (Session): 当前会话对象
            query (str): 用户问题文本

        Returns:
            str: 最终回复文本
        """
        # 确保 narrative 组件已初始化
        await self.initialize_narrative()
        session.add_message(UserMessage(content=query))

        # 获取查询的结果
        results = await self.narrative.query(query, mode="hybrid", top_k=20) if self.narrative else {}
        # 构建剧情检索 Context
        context = (
            "\n\n".join([f"### {timeline}\n{content}" for timeline, content in results.items()])
            if results
            else "（未找到相关剧情）"
        )

        # 构建完整的消息列表
        messages = await self._build_chat_messages(
            session=session,
            extra_system=f"## 剧情简介\n{self.narrative.get_summary() if self.narrative else ''}",
            extra_user=f"[背景信息]\n{context}\n\n[用户提问]",
        )
        # 调用通用的聊天处理函数 该函数会将消息发送给 LLM 并处理回复文本 
        # 同时支持 TTS 生成和情绪分析等功能
        return await self._chat_with_tts(messages, session)

    async def _handle_narrative_stream(
        self,
        session: Session,
        query: str,
        on_token: Optional[Callable[[str], Awaitable[None]]] = None,
        should_stop: Optional[Callable[[], bool]] = None,
    ) -> tuple[str, bool]:
        """
        处理 narrative 模式流式请求

        Args:
            session (Session): 当前会话对象
            query (str): 用户问题文本
            on_token (Optional[Callable[[str], Awaitable[None]]]): token 回调函数
            should_stop (Optional[Callable[[], bool]]): 外部中断判定函数

        Returns:
            tuple[str, bool]: 回复文本 与 是否中断标记
        """
        # 确保 narrative 组件已初始化
        await self.initialize_narrative()
        session.add_message(UserMessage(content=query))

        # 获取查询的结果
        results = await self.narrative.query(query, mode="hybrid", top_k=20) if self.narrative else {}
        # 构建剧情检索 Context
        context = (
            "\n\n".join([f"### {timeline}\n{content}" for timeline, content in results.items()])
            if results
            else "（未找到相关剧情）"
        )

        # 构建完整的消息列表
        messages = await self._build_chat_messages(
            session=session,
            extra_system=f"## 剧情简介\n{self.narrative.get_summary() if self.narrative else ''}",
            extra_user=f"[背景信息]\n{context}\n\n[用户提问]",
        )
        # 调用通用的聊天处理函数 该函数会将消息发送给 LLM 并处理回复文本
        return await self._chat_stream(messages, session, on_token=on_token, should_stop=should_stop)

    async def _handle_agent(self, session: Session, user_input: str) -> str:
        """
        处理 agent 模式非流式请求

        Args:
            session (Session): 当前会话对象
            user_input (str): 用户输入文本

        Returns:
            str: 最终润色后的回复文本
        """
        logger.info("[Agent mode] running ReAct.")
        # 直接调用
        state: AgentRuntimeState = await self.agent.run(user_input, session)
        final_answer = state.final_answer or ""

        if state.error:
            error_msg = f"抱歉，执行过程中出现错误：{state.error}"
            session.add_message(AssistantMessage(content=error_msg))
            return error_msg
        
        # 将 agent 的最终答案进行润色 以符合艾玛的语气和风格 同时保持人设并且不输出提示语 以增强用户体验
        messages = await self._build_chat_messages(
            session=session,
            extra_user=(
                "请将以下 Agent 结果整理为专业且有人物特色的最终答复。"
                "要求：1) 必须完整保留关键结论与技术重点，不得遗漏。"
                "2) 必须写清关键依据（来自哪些工具结果、文件路径、命令输出要点）。"
                "3) 输出结构固定为：结论、关键依据、可执行下一步。"
                "4) 保持艾玛风格但措辞专业，不输出“我来润色”等提示语。\n\n"
                f"{final_answer}"
            ),
        )

        # 调用通用的聊天处理函数 该函数会将消息发送给 LLM 并处理回复文本
        return await self._chat_with_tts(messages, session)

    async def _handle_agent_stream(
        self,
        session: Session,
        user_input: str,
        on_token: Optional[Callable[[str], Awaitable[None]]] = None,
        should_stop: Optional[Callable[[], bool]] = None,
    ) -> tuple[str, bool]:
        """
        处理 agent 模式流式请求

        Args:
            session (Session): 当前会话对象
            user_input (str): 用户输入文本
            on_token (Optional[Callable[[str], Awaitable[None]]]): token 回调函数
            should_stop (Optional[Callable[[], bool]]): 外部中断判定函数

        Returns:
            tuple[str, bool]: 回复文本 与 是否中断标记
        """
        logger.info("[Agent mode] running ReAct.")
        state: AgentRuntimeState = await self.agent.run(user_input, session)
        final_answer = state.final_answer or ""

        if state.error:
            error_msg = f"抱歉，执行过程中出现错误：{state.error}"
            session.add_message(AssistantMessage(content=error_msg))
            if on_token:
                result = on_token(error_msg)
                if asyncio.iscoroutine(result):
                    await result
            return error_msg, False

        messages = await self._build_chat_messages(
            session=session,
            extra_user=(
                "请将以下 Agent 结果整理为专业且有人物特色的最终答复。"
                "要求：1) 必须完整保留关键结论与技术重点，不得遗漏。"
                "2) 必须写清关键依据（来自哪些工具结果、文件路径、命令输出要点）。"
                "3) 输出结构固定为：结论、关键依据、可执行下一步。"
                "4) 保持艾玛风格但措辞专业，不输出“我来润色”等提示语。\n\n"
                f"{final_answer}"
            ),
        )
        return await self._chat_stream(messages, session, on_token=on_token, should_stop=should_stop)

    async def _handle_chat(self, session: Session, user_input: str) -> str:
        """
        处理 chat 模式非流式请求

        Args:
            session (Session): 当前会话对象
            user_input (str): 用户输入文本

        Returns:
            str: 回复文本
        """
        session.add_message(UserMessage(content=user_input))
        messages = await self._build_chat_messages(session=session)
        return await self._chat_with_tts(messages, session)

    async def _handle_chat_stream(
        self,
        session: Session,
        user_input: str,
        on_token: Optional[Callable[[str], Awaitable[None]]] = None,
        should_stop: Optional[Callable[[], bool]] = None,
    ) -> tuple[str, bool]:
        """
        处理 chat 模式流式请求

        Args:
            session (Session): 当前会话对象
            user_input (str): 用户输入文本
            on_token (Optional[Callable[[str], Awaitable[None]]]): token 回调函数
            should_stop (Optional[Callable[[], bool]]): 外部中断判定函数

        Returns:
            tuple[str, bool]: 回复文本 与 是否中断标记
        """
        session.add_message(UserMessage(content=user_input))
        messages = await self._build_chat_messages(session=session)
        return await self._chat_stream(messages, session, on_token=on_token, should_stop=should_stop)

    async def _build_chat_messages(
        self,
        session: Session,
        extra_system: str = "",
        extra_user: str = "",
    ) -> List[Dict[str, Any]]:
        """
        构建发送给 LLM 的消息数组

        该方法会注入系统提示并合并会话上下文
        同时支持额外系统文本与额外用户文本

        Args:
            session (Session): 当前会话对象
            extra_system (str): 追加到系统提示的文本
            extra_user (str): 追加到用户侧的文本

        Returns:
            List[Dict[str, Any]]: 可直接发送到 LLM 的消息列表
        """
        # 基础系统提示为预设的人设与背景介绍 
        # 如果调用时提供了额外的系统提示文本 则将其追加到基础提示后 以便在特定场景下提供更多指导信息
        system_prompt = self.system_prompt
        if extra_system:
            system_prompt += f"\n\n{extra_system}"

        # 构建消息列表 首先是系统提示 然后是会话上下文中的消息
        # 这些消息会按照时间顺序排列 以便 LLM 理解对话历史
        messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]
        # 遍历会话上下文中的消息 将它们转换为字典格式并添加到消息列表中
        for msg in session.get_context_for_llm():
            messages.append(msg.to_dict())

        # 如果调用时提供了额外的用户文本 则将其追加到最后一个用户消息后 以便在特定场景下提供更多上下文信息
        if extra_user:
            if messages and messages[-1]["role"] == "user":
                messages[-1]["content"] = f"{extra_user}\n\n{messages[-1]['content']}"
            else:
                messages.append({"role": "user", "content": extra_user})

        # 单条消息保护 避免附件正文或历史单条过长
        for msg in messages:
            content = msg.get("content")
            if isinstance(content, str):
                msg["content"] = self._truncate_text(content, MAX_SINGLE_MESSAGE_CHARS)

        # 总上下文保护 保留 system 与最近消息
        total_chars = sum(len(str(m.get("content", ""))) for m in messages)
        if total_chars > MAX_TOTAL_CONTEXT_CHARS:
            system_msg = messages[0] if messages else {"role": "system", "content": system_prompt}
            kept: List[Dict[str, Any]] = []
            used = len(str(system_msg.get("content", "")))

            for msg in reversed(messages[1:]):
                length = len(str(msg.get("content", "")))
                if used + length > MAX_TOTAL_CONTEXT_CHARS:
                    continue
                kept.append(msg)
                used += length

            kept.reverse()
            messages = [system_msg] + kept

        return messages

    async def _chat_with_tts(self, messages: List[Dict[str, Any]], session: Session) -> str:
        """
        调用 LLM 并执行 TTS 合成

        当存在 tts_manager 时使用流式文本驱动语音
        否则退化为普通非流式回复

        Args:
            messages (List[Dict[str, Any]]): LLM 请求消息列表
            session (Session): 当前会话对象

        Returns:
            str: 回复文本
        """
        if self.tts_manager:
            response = await self.llm_client.chat(
                messages=messages,
                stream=True,
                on_token_callback=self.tts_manager.add_text_stream,
                emit_stdout=True,
            )
            await self.tts_manager.flush()
        else:
            response = await self.llm_client.chat(messages=messages, stream=False)

        session.add_message(AssistantMessage(content=response))
        return response

    async def _chat_stream(
        self,
        messages: List[Dict[str, Any]],
        session: Session,
        on_token: Optional[Callable[[str], Awaitable[None]]] = None,
        should_stop: Optional[Callable[[], bool]] = None,
    ) -> tuple[str, bool]:
        """
        执行纯流式聊天并按需中断

        Args:
            messages (List[Dict[str, Any]]): LLM 请求消息列表
            session (Session): 当前会话对象
            on_token (Optional[Callable[[str], Awaitable[None]]]): token 回调函数
            should_stop (Optional[Callable[[], bool]]): 外部中断判定函数

        Returns:
            tuple[str, bool]: 回复文本 与 是否中断标记
        """
        # 逐 token 收集生成结果 并在每次收到新 token 时调用 on_token 回调函数 以支持实时显示生成内容
        chunks: List[str] = []
        stopped = False

        async for token in self.llm_client.stream_chat(messages=messages):
            # 在每次收到新 token 时 首先检查 should_stop 函数 如果该函数存在且返回 True 则中断生成过程 并设置 stopped 标记为 True 以便后续处理知道生成被中断了
            if should_stop and should_stop():
                stopped = True
                break

            # 将新 token 添加到结果列表中 并调用 on_token 回调函数 以支持实时显示生成内容
            chunks.append(token)
            if on_token:
                result = on_token(token)
                if asyncio.iscoroutine(result):
                    await result

        # 将所有 token 拼接成完整的回复文本 并去除首尾空白 如果生成过程中被中断了 则该文本可能是不完整的 但仍然可以作为当前已生成内容的展示
        response = "".join(chunks).strip()
        if response:
            session.add_message(AssistantMessage(content=response))
        return response, stopped

    async def _speak(self, text: str):
        """
        仅执行语音播报流程

        Args:
            text (str): 待播报文本

        Returns:
            None
        """
        if self.tts_manager:
            await self.tts_manager.add_text_stream(text)
            await self.tts_manager.flush()

    async def close(self):
        """
        释放代理持有的资源

        包括 narrative 资源与 tts 资源

        Args:
            None

        Returns:
            None
        """
        if self.narrative:
            await self.narrative.finalize()
        if self.tts_manager:
            self.tts_manager.stop()


async def main():
    """
    命令行调试入口(2026.1之前在终端上测试用的)

    该函数用于本地快速验证 EmaAgent 运行效果
    """
    import sys
    from pathlib import Path

    root = Path(__file__).parent.parent
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    from config.paths import init_paths

    init_paths(root)
    app = EmaAgent()
    session_id = "ema"

    try:
        while True:
            user_input = input("\nYou: ").strip()
            if not user_input:
                continue
            if user_input.lower() in {"exit", "quit"}:
                break

            result = await app.run(user_input, session_id=session_id, mode="chat")
            print(f"\nAnswer: {result['answer']}")
            print(f"Duration: {result['duration']:.2f}s | Mode: {result['intent']}")
    except KeyboardInterrupt:
        pass
    finally:
        await app.close()


if __name__ == "__main__":
    asyncio.run(main())
