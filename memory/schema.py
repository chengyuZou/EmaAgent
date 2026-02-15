"""
内存与会话数据结构模块

该模块定义消息、会话、压缩历史以及 Agent 运行态的数据模型
用于在内存管理、序列化持久化与上下文构建之间共享统一结构
"""

from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional, TYPE_CHECKING
from datetime import datetime
from enum import Enum
import json

if TYPE_CHECKING:
    from memory.compressor import Compressor

@dataclass
class Message:
    """
    消息基础模型

    该类描述通用消息结构 支持普通文本、工具调用及工具结果消息

    并提供序列化与反序列化方法

    Args:
        role (str): Message 角色 通常为 "user"、"assistant"、"system" 或 "tool"
        content (str): Message 内容 可为文本或 JSON 字符串
        timestamp (str): 消息时间戳 ISO 格式字符串 由默认工厂生成当前时间
        name (Optional[str]): 工具名称仅 tool 消息使用
        tool_call_id (Optional[str]): 工具调用 ID 仅 tool 消息使用
        tool_calls (Optional[List[Dict[str, Any]]]): 工具调用列表仅 assistant 消息使用
        base64_image (Optional[str]): 可选的 Base64 编码图像数据 暂不使用

    Returns:
        Message: Message 对象实例

    Examples:
        >>> msg = Message(role="user", content="hello")
        >>> msg.role
        'user'
    """
    role: str  # user, assistant, system, tool
    content: str
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())

    name: Optional[str] = None  # 工具名称（tool 消息用）
    tool_call_id: Optional[str] = None  # 工具调用 ID（tool 消息用）
    tool_calls: Optional[List[Dict[str, Any]]] = None  # 工具调用列表（assistant 消息用）

    base64_image: Optional[str] = None  # (2026.2.2)暂时不打算使用

    def __add__(self, other) -> List["Message"]:
        """
        支持消息加法操作

        该方法允许 `Message + Message` 或 `Message + list[Message]`

        便于组装消息序列

        Args:
            other (Any): other operand 支持 Message 或 list[Message]

        Returns:
            List[Message]: 组合后的消息列表

        Raises:
            TypeError: 当 other 既不是 Message 也不是 list 时抛出

        Examples:
            >>> a = Message(role="user", content="A")
            >>> b = Message(role="assistant", content="B")
            >>> len(a + b)
            2
        """
        if isinstance(other, list):
            return [self] + other
        elif isinstance(other, Message):
            return [self, other]
        else:
            raise TypeError(
                f"不支持的 type(s): '{type(self).__name__}' and '{type(other).__name__}' 当前仅支持 Message + Message 或 Message + list[Message] 的组合方式"
            )

    def __radd__(self, other) -> List["Message"]:
        """
        支持反向消息加法操作

        该方法允许 `list[Message] + Message` 形式

        Args:
            other (Any): other operand 支持 list[Message]

        Returns:
            List[Message]: 组合后的消息列表

        Raises:
            TypeError: 当 other 不是 list 时抛出

        Examples:
            >>> a = Message(role="user", content="A")
            >>> len([a] + a)
            2
        """
        if isinstance(other, list):
            return other + [self]
        else:
            raise TypeError(
                f"不支持的 type(s): '{type(other).__name__}' and '{type(self).__name__}' 当前仅支持 list[Message] + Message 的组合方式"
            )

    def to_dict(self) -> dict:
        """
        将消息对象序列化为字典

        该方法会根据不同角色附加对应字段，并确保 content 为可序列化字符串

        Args:
            None:

        Returns:
            dict: 序列化的JSON兼容字典

        Examples:
            >>> msg = Message(role="user", content="hello")
            >>> d = msg.to_dict()
            >>> d["role"]
            'user'
        """
        message = {"role": self.role, "timestamp": self.timestamp}

        # 统一处理 content 避免 dict/list 直接写入导致结构不一致
        if self.content is not None:
            # 如果 content 是 dict 或 list 则转换为 JSON 字符串 否则直接转换为字符串
            if isinstance(self.content, (dict, list)):
                message["content"] = json.dumps(self.content, ensure_ascii=False)
            else:
                message["content"] = str(self.content)

        # content 允许为 None 但最终输出应为字符串 这里统一转换为 "" 避免后续处理复杂化
        else:
            message["content"] = ""

        # assistant 消息可携带 tool_calls
        if self.role == "assistant" and self.tool_calls:
            message["tool_calls"] = self.tool_calls

        # tool 消息可携带工具名称与调用 ID
        if self.role == "tool":
            if self.name is not None:
                message["name"] = self.name
            if self.tool_call_id is not None:
                message["tool_call_id"] = self.tool_call_id

        return message

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Message":
        """
        从字典反序列化消息对象

        该方法使用工厂分发逻辑 根据 `role` 返回对应消息子类

        并在最后统一恢复 timestamp

        Args:
            data (Dict[str, Any]): 包含消息数据的字典 需包含 "role" 字段 可选 "content"、"timestamp"、"tool_calls"、"name"、"tool_call_id"

        Returns:
            Message: 根据 role 解析后的消息对象实例

        Examples:
            >>> msg = Message.from_dict({"role": "user", "content": "hello"})
            >>> msg.role
            'user'
        """
        role = data.get("role")
        content = data.get("content", "")

        # 保证 content 最终为字符串格式
        if isinstance(content, (dict, list)):
            content = json.dumps(content, ensure_ascii=False)
        elif content is None:
            content = ""

        # 读取已有时间戳 若缺失则补当前时间
        ts = data.get("timestamp", datetime.now().isoformat())

        msg_obj = None

        # 1) SystemMessage
        if role == "system":
            msg_obj = SystemMessage(content=content)

        # 2) UserMessage
        elif role == "user":
            msg_obj = UserMessage(content=content, base64_image=data.get("base64_image"))

        # 3) AssistantMessage
        elif role == "assistant":
            msg_obj = AssistantMessage(
                content=content,
                tool_calls=data.get("tool_calls")
            )

        # 4) ToolMessage
        elif role == "tool":
            msg_obj = ToolMessage(
                content=content,
                name=data.get("name", ""),
                tool_call_id=data.get("tool_call_id", "")
            )

        # 5) 未知角色回退到基类
        else:
            msg_obj = cls(role=role, content=content, tool_calls=data.get("tool_calls"))

        # 子类构造通常不带 timestamp 这里统一恢复
        msg_obj.timestamp = ts

        return msg_obj


@dataclass
class SystemMessage(Message):
    """
    系统消息模型

    Args:
        content (str): System 文本

    Returns:
        SystemMessage: SystemMessage 对象实例

    Examples:
        >>> msg = SystemMessage("policy")
        >>> msg.role
        'system'
    """
    role: str = field(default="system", init=False)

    def __init__(self, content: str):
        """
        初始化系统消息

        Args:
            content (str): System content

        Returns:
            None

        Examples:
            >>> msg = SystemMessage("rules")
            >>> msg.content
            'rules'
        """
        super().__init__(role="system", content=content)


@dataclass
class UserMessage(Message):
    """
    用户消息模型

    Args:
        content (str): User text
        base64_image (Optional[str]): Optional image payload

    Returns:
        UserMessage: User message instance

    Examples:
        >>> msg = UserMessage("hello")
        >>> msg.role
        'user'
    """
    role: str = field(default="user", init=False)

    def __init__(self, content: str, base64_image: Optional[str] = None):
        """
        初始化用户消息

        Args:
            content (str): User content
            base64_image (Optional[str]): Optional image payload

        Returns:
            None

        Examples:
            >>> msg = UserMessage("hello")
            >>> msg.content
            'hello'
        """
        super().__init__(role="user", content=content, base64_image=base64_image)


@dataclass
class AssistantMessage(Message):
    """
    助手消息模型

    Args:
        content (str): Assistant text content
        tool_calls (Optional[List[Dict]]): Optional tool call list

    Returns:
        AssistantMessage: Assistant message instance

    Examples:
        >>> msg = AssistantMessage("ok")
        >>> msg.role
        'assistant'
    """
    role: str = field(default="assistant", init=False)

    def __init__(self, content: str = "", tool_calls: Optional[List[Dict]] = None):
        """
        初始化助手消息

        Args:
            content (str): Assistant text
            tool_calls (Optional[List[Dict]]): Tool call metadata

        Returns:
            None

        Examples:
            >>> msg = AssistantMessage(content="done")
            >>> msg.content
            'done'
        """
        super().__init__(role="assistant", content=content, tool_calls=tool_calls)


@dataclass
class ToolMessage(Message):
    """
    工具消息模型

    Args:
        content (str): Tool output content
        name (str): Tool name
        tool_call_id (str): Tool call identifier

    Returns:
        ToolMessage: Tool message instance

    Examples:
        >>> msg = ToolMessage(content="{}", name="search", tool_call_id="call_1")
        >>> msg.role
        'tool'
    """
    role: str = field(default="tool", init=False)

    def __init__(self, content: str, name: str, tool_call_id: str):
        """
        初始化工具消息

        Args:
            content (str): Tool output content
            name (str): Tool name
            tool_call_id (str): Tool call identifier

        Returns:
            None:

        Examples:
            >>> msg = ToolMessage("ok", "run", "id1")
            >>> msg.name
            'run'
        """
        super().__init__(role="tool", content=content, name=name, tool_call_id=tool_call_id)


@dataclass
class CompressionRecord:
    """
    单次压缩记录模型

    Args:
        compressed_at (str): 压缩时间 ISO 格式字符串
        original_count (int): 原始消息数
        compressed_count (int): 压缩后消息数
        summary (str): 压缩摘要文本
        compressed_range (tuple): 压缩的消息范围 (start_idx, end_idx)

    Returns:
        CompressionRecord: CompressionRecord 实例

    Examples:
        >>> r = CompressionRecord("t", 10, 1, "sum", (0, 9))
        >>> r.original_count
        10
    """
    compressed_at: str  # 压缩时间
    original_count: int  # 原始消息数
    compressed_count: int  # 压缩后消息数
    summary: str  # 压缩摘要
    compressed_range: tuple  # 压缩的消息范围 (start_idx, end_idx)

    def to_dict(self) -> Dict[str, Any]:
        """
        将压缩记录转换为字典

        Args:
            None:

        Returns:
            Dict[str, Any]: 可序列化的压缩记录字典

        Examples:
            >>> d = CompressionRecord("t", 10, 1, "sum", (0, 9)).to_dict()
            >>> d["compressed_count"]
            1
        """
        return {
            "compressed_at": self.compressed_at,
            "original_count": self.original_count,
            "compressed_count": self.compressed_count,
            "summary": self.summary,
            "compressed_range": list(self.compressed_range)
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CompressionRecord":
        """
        从字典创建压缩记录

        Args:
            data (Dict[str, Any]): 包含压缩记录的字典 需包含 `compressed_at` `original_count` `compressed_count` `summary` `compressed_range`

        Returns:
            CompressionRecord: 根据字典数据解析后的 CompressionRecord 实例

        Examples:
            >>> r = CompressionRecord.from_dict({"compressed_at":"t","original_count":1,"compressed_count":1,"summary":"s","compressed_range":[0,1]})
            >>> r.summary
            's'
        """
        return cls(
            compressed_at=data["compressed_at"],
            original_count=data["original_count"],
            compressed_count=data["compressed_count"],
            summary=data["summary"],
            compressed_range=tuple(data["compressed_range"])
        )


@dataclass
class CompressionHistory:
    """
    压缩历史模型

    Args:
        records (List[CompressionRecord]): 历史压缩记录列表
        current_summary (str): 当前有效的压缩摘要文本
        last_compression_time (Optional[str]): 上次压缩时间 ISO 格式字符串
        total_compressions (int): 总压缩次数

    Returns:
        CompressionHistory: CompressionHistory 实例

    Examples:
        >>> h = CompressionHistory()
        >>> h.total_compressions
        0
    """
    records: List[CompressionRecord] = field(default_factory=list)
    current_summary: str = ""  # 当前有效的压缩摘要
    last_compression_time: Optional[str] = None  # 上次压缩时间
    total_compressions: int = 0  # 总压缩次数

    def add_record(self, record: CompressionRecord):
        """
        添加一条压缩记录并刷新聚合状态

        Args:
            record (CompressionRecord): 新压缩记录对象

        Returns:
            None

        Examples:
            >>> h = CompressionHistory()
            >>> h.add_record(CompressionRecord("t", 10, 1, "s", (0, 9)))
            >>> h.total_compressions
            1
        """
        # 添加新记录并更新
        self.records.append(record)
        self.current_summary = record.summary
        self.last_compression_time = record.compressed_at
        self.total_compressions += 1

    def to_dict(self) -> Dict[str, Any]:
        """
        将压缩历史转换为字典

        Args:
            None:

        Returns:
            Dict[str, Any]: 可序列化的压缩历史字典

        Examples:
            >>> d = CompressionHistory().to_dict()
            >>> "records" in d
            True
        """
        return {
            "records": [r.to_dict() for r in self.records],
            "current_summary": self.current_summary,
            "last_compression_time": self.last_compression_time,
            "total_compressions": self.total_compressions
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CompressionHistory":
        """
        从字典创建压缩历史

        Args:
            data (Dict[str, Any]): 包含压缩历史信息的字典

        Returns:
            CompressionHistory: 解析后的压缩历史对象实例

        Examples:
            >>> h = CompressionHistory.from_dict({})
            >>> isinstance(h, CompressionHistory)
            True
        """
        return cls(
            records=[CompressionRecord.from_dict(r) for r in data.get("records", [])],
            current_summary=data.get("current_summary", ""),
            last_compression_time=data.get("last_compression_time"),
            total_compressions=data.get("total_compressions", 0)
        )


@dataclass
class Session:
    """
    会话模型

    该类承载完整会话状态 包括消息历史、压缩状态与上下文构建参数

    Args:
        session_id (str): Session ID 唯一标识一个会话实例(目前用来做title与文件夹命名)
        created_at (str): 创建时间 ISO 格式字符串 由默认工厂生成当前时间
        updated_at (str): 更新时间 ISO 格式字符串 由默认工厂生成当前时间
        messages (List[Message]): 消息列表 持久化存储的核心数据结构
        compression_history (CompressionHistory): 压缩历史记录对象
        compressed_until_index (int): 已压缩到的消息索引 游标形式指示哪些消息已被摘要覆盖
        max_context_messages (int): LLM 上下文最大消息数 超过该数会优先保留最近消息
        compression_threshold (int): 触发压缩的消息数阈值 当未压缩消息数达到该值时会考虑执行压缩
        keep_recent_turns (int): 压缩时保留的最近对话轮数 以避免破坏短期上下文连贯性
        min_compression_interval_hours (float): 最小压缩间隔(小时) 当距离上次压缩时间未超过该值时会跳过压缩以避免过度压缩
        total_runs (int): 总运行次数 该统计字段可用于监控会话活跃度与压缩触发频率

    Returns:
        Session: Session 对象实例

    Examples:
        >>> s = Session(session_id="demo")
        >>> s.session_id
        'demo'
    """
    session_id: str
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())

    # 核心数据：消息列表(持久化存储的主要内容)
    messages: List[Message] = field(default_factory=list)

    # 压缩相关
    compression_history: CompressionHistory = field(default_factory=CompressionHistory)
    compressed_until_index: int = 0  # 已压缩到的消息索引

    # 配置
    max_context_messages: int = 20  # LLM 上下文最大消息数
    compression_threshold: int = 15  # 触发压缩的消息数阈值
    keep_recent_turns: int = 10  # 压缩时保留的最近对话轮数
    min_compression_interval_hours: float = 1.0  # 最小压缩间隔(小时)

    # 统计数据
    total_runs: int = 0

    def add_message(self, message: Message):
        """
        追加一条消息并刷新会话状态

        Args:
            message (Message): 待添加的消息对象实例

        Returns:
            None:

        Examples:
            >>> s = Session("x")
            >>> s.add_message(UserMessage("hi"))
            >>> len(s.messages)
            1
        """
        self.messages.append(message)
        self.updated_at = datetime.now().isoformat()
        self.total_runs += 1

    def get_uncompressed_messages(self) -> List[Message]:
        """
        获取尚未压缩的消息切片

        Args:
            None:

        Returns:
            List[Message]: 从 compressed_until_index 到消息列表末尾的消息切片 代表当前未被摘要覆盖的消息段

        Examples:
            >>> s = Session("x")
            >>> isinstance(s.get_uncompressed_messages(), list)
            True
        """
        return self.messages[self.compressed_until_index:]

    def get_context_for_llm(self) -> List[Message]:
        """
        构建提供给 LLM 的上下文消息

        结构规则:
        1) 若存在压缩摘要 先插入一条系统摘要消息
        2) 再附加清洗后的最近消息 过滤 tool 消息和 tool_calls 结构

        Args:
            None:

        Returns:
            List[Message]: 构建好的上下文消息列表 可直接输入 LLM 进行对话生成

        Examples:
            >>> s = Session("x")
            >>> ctx = s.get_context_for_llm()
            >>> isinstance(ctx, list)
            True
        """
        context = []

        # 1) 先注入摘要系统消息 提供历史记忆
        if self.compression_history.current_summary:
            context.append(SystemMessage(
                content=f"[历史对话摘要]\n{self.compression_history.current_summary}"
            ))

        # 2) 读取未压缩消息并执行清洗
        uncompressed = self.get_uncompressed_messages()

        # 清洗规则: assistant 消息去除 tool_calls, tool 消息直接丢弃
        cleaned_messages = []
        for msg in uncompressed:
            if msg.role == "assistant" and (isinstance(msg, AssistantMessage) or msg.tool_calls):
                cleaned_msg = AssistantMessage(
                    content=msg.content,
                    tool_calls=None
                )
                cleaned_messages.append(cleaned_msg)
            elif msg.role == "tool":
                continue  # 丢弃 Tool 消息
            else:
                cleaned_messages.append(msg)

        # 3) 从清洗后的消息中截取最近 max_context_messages 条以构建上下文
        recent_messages = cleaned_messages[-self.max_context_messages:]
        context.extend(recent_messages)

        return context

    def should_compress(self) -> bool:
        """
        判断当前是否满足压缩条件

        未压缩消息数量达到阈值
        距离上次压缩已超过最小时间间隔(若有历史)

        Args:
            None:

        Returns:
            bool: 是否满足压缩条件 供 compress_if_needed 方法调用以决定是否执行压缩

        Examples:
            >>> s = Session("x")
            >>> isinstance(s.should_compress(), bool)
            True
        """
        # 计算当前未压缩消息数量
        uncompressed_count = len(self.get_uncompressed_messages())

        # 条件 1: 消息数未达到阈值 直接返回 False 避免过早压缩
        if uncompressed_count < self.compression_threshold:
            return False

        # 条件 2: 压缩间隔未满足 如果存在上次压缩时间 则计算距离当前时间的小时数 是否超过设定的最小压缩间隔
        if self.compression_history.last_compression_time:
            last_time = datetime.fromisoformat(self.compression_history.last_compression_time)
            hours_passed = (datetime.now() - last_time).total_seconds() / 3600
            if hours_passed < self.min_compression_interval_hours:
                return False

        return True

    async def compress_if_needed(self, compressor: "Compressor") -> bool:
        """
        在满足条件时执行异步压缩

        该方法会跳过过短消息段 并在压缩成功后写入压缩记录与索引游标

        Args:
            compressor (Compressor): Compressor 对象实例

        Returns:
            bool: 是否执行了压缩操作 True 代表已执行压缩 False 代表未满足条件未执行压缩

        Examples:
            >>> # await session.compress_if_needed(compressor)
            >>> # Returns False when conditions are not met.
            pass
        """
        # 前置检查: 压缩器实例必须存在 且 满足压缩条件 否则直接返回 False 跳过压缩
        if compressor is None:
            return False
        
        # 检查是否满足压缩条件 包括未压缩消息数和压缩间隔
        if not self.should_compress():
            return False

        # 获取可压缩消息段
        messages_to_compress = self.get_uncompressed_messages()

        # 保留最近轮次 避免破坏短期上下文连贯性 只有当可压缩消息数超过保留轮次时才执行压缩 否则直接返回 False 跳过压缩
        if len(messages_to_compress) <= self.keep_recent_turns:
            return False

        compress_messages = messages_to_compress[:-self.keep_recent_turns]

        # 调用压缩器生成新的汇总摘要
        summary = await compressor.compress(
            messages=compress_messages,
            existing_summary=self.compression_history.current_summary
        )

        # 计算压缩区间并生成记录
        start_idx = self.compressed_until_index
        end_idx = len(self.messages) - self.keep_recent_turns

        record = CompressionRecord(
            compressed_at=datetime.now().isoformat(),
            original_count=len(compress_messages),
            compressed_count=1,  # 压缩成一条摘要
            summary=summary,
            compressed_range=(start_idx, end_idx)
        )

        # 更新压缩历史与已压缩游标
        self.compression_history.add_record(record)
        # 这里不进行 self.compression_history.current_summary = summary 的原因是 
        # add_record 方法已经在内部处理了 current_summary 的更新 因此无需在外部重复设置
        self.compressed_until_index = end_idx

    def to_dict(self) -> Dict[str, Any]:
        """
        将会话元信息序列化为字典

        该方法用于生成 `session.json` 不包含完整消息与压缩 records 内容

        Args:
            None:

        Returns:
            Dict[str, Any]: 包含 session 元信息的字典 可用于持久化存储与后续恢复

        Examples:
            >>> d = Session("x").to_dict()
            >>> d["session_id"]
            'x'
        """
        return {
            "session_id": self.session_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "compressed_until_index": self.compressed_until_index,
            "max_context_messages": self.max_context_messages,
            "compression_threshold": self.compression_threshold,
            "min_compression_interval_hours": self.min_compression_interval_hours,
            "total_runs": self.total_runs
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Session":
        """
        从元信息字典恢复会话对象

        注意: 该方法仅恢复 session 元字段，不加载 messages 与 compression records

        Args:
            data (Dict[str, Any]): Session 元信息字典

        Returns:
            Session: Session 对象实例 但 messages 与 compression_history 仍需通过其他方式加载

        Examples:
            >>> s = Session.from_dict({"session_id": "x"})
            >>> s.session_id
            'x'
        """
        return cls(
            session_id=data["session_id"],
            created_at=data.get("created_at", datetime.now().isoformat()),
            updated_at=data.get("updated_at", datetime.now().isoformat()),
            compressed_until_index=data.get("compressed_until_index", 0),
            max_context_messages=data.get("max_context_messages", 20),
            compression_threshold=data.get("compression_threshold", 15),
            min_compression_interval_hours=data.get("min_compression_interval_hours", 1.0),
            total_runs=data.get("total_runs", 0)
        )


class AgentStatus(str, Enum):
    """
    Agent 运行状态枚举

    Args:
        None:

    Returns:
        AgentStatus: AgentStatus 枚举类实例 包含 IDLE、THINKING、ACTING、FINISHED、ERROR 五种状态

    Examples:
        >>> AgentStatus.IDLE.value
        'idle'
    """
    IDLE = "idle"
    THINKING = "thinking"
    ACTING = "acting"
    FINISHED = "finished"
    ERROR = "error"


@dataclass
class AgentRuntimeState:
    """
    Agent 运行时状态模型

    该模型在一次 run 生命周期内承载步骤计数、工具调用、中间思考与最终结果

    并保留对原始会话对象的引用

    Args:
        session (Session): 原始 Session 对象引用 供运行时访问与修改
        user_input (str): 用户输入文本 供当前 run 使用
        messages (List[Message]): 当前 run 使用的消息列表 可能是原始消息的压缩版本 供 LLM 输入使用
        current_step (int): 当前 ReAct 步骤计数 从 0 开始 每执行一次思考或行动后递增
        max_steps (int): 最大步骤限制 超过该步数后会强制结束以避免无限循环
        status (AgentStatus): 当前运行状态 供流程控制与监控使用
        current_thought (str): 当前思考文本 供调试与监控使用 可在每次思考后更新以反映最新的内部状态
        current_action (str): 当前行动文本 供调试与监控使用 可在每次行动后更新以反映最新的执行状态
        current_tool_calls (List[Dict]): 当前工具调用列表 供调试与监控使用 可在每次行动后更新以反映最新的工具调用状态
        tool_results (List[Dict]): 当前工具结果列表 供调试与监控使用 可在每次工具调用完成后更新以反映最新的工具执行结果
        final_answer (str): 最终答案文本 供当前 run 使用 在流程结束时更新以反映最终输出结果
        start_time (datetime): 运行开始时间 由默认工厂生成当前时间 供运行时统计使用
        end_time (Optional[datetime]): 运行结束时间 供运行时统计使用 在流程结束时更新以反映实际结束时间
        error (Optional[str]): 错误信息 供运行时错误捕获与监控使用 在流程发生异常时更新以反映错误详情

    Returns:
        AgentRuntimeState: AgentRuntimeState 对象实例 供一次 run 生命周期内使用 该对象不设计持久化存储 仅在内存中存在以支持流程中的状态管理与监控

    Examples:
        >>> s = Session("x")
        >>> rt = AgentRuntimeState(session=s, user_input="hi", messages=[])
        >>> rt.status == AgentStatus.IDLE
        True
    """
    session: Session  # 原始会话引用
    user_input: str
    messages: List[Message]  # 用于 LLM 的消息（可能压缩）

    # ReAct 循环变量
    current_step: int = 0
    max_steps: int = 20
    status: AgentStatus = AgentStatus.IDLE

    # 思考相关
    current_thought: str = ""

    # 动作相关
    current_action: str = ""
    current_tool_calls: List[Dict] = field(default_factory=list)
    tool_results: List[Dict] = field(default_factory=list)

    # 结果
    final_answer: str = ""

    # 时间统计
    start_time: datetime = field(default_factory=datetime.now)
    end_time: Optional[datetime] = None

    # 错误
    error: Optional[str] = None

    @property
    def duration(self) -> float:
        """
        计算运行耗时(秒)

        若已结束则使用 `end_time - start_time` 否则使用当前时间与开始时间差

        Args:
            None:

        Returns:
            float: 运行耗时(秒) 供监控与统计使用 反映一次 run 从开始到当前的时间长度

        Examples:
            >>> s = Session("x")
            >>> rt = AgentRuntimeState(session=s, user_input="hi", messages=[])
            >>> isinstance(rt.duration, float)
            True
        """
        if self.end_time:
            return (self.end_time - self.start_time).total_seconds()
        return (datetime.now() - self.start_time).total_seconds()

    @property
    def is_finished(self) -> bool:
        """
        判断运行是否已结束

        结束条件为状态处于 `FINISHED` 或 `ERROR`

        Args:
            None: 

        Returns:
            bool: True when runtime has finished.

        Examples:
            >>> s = Session("x")
            >>> rt = AgentRuntimeState(session=s, user_input="hi", messages=[])
            >>> isinstance(rt.is_finished, bool)
            True
        """
        return self.status in (AgentStatus.FINISHED, AgentStatus.ERROR)
