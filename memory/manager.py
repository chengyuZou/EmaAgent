"""
会话管理器模块

该模块负责会话的创建、加载、保存、删除与缓存管理
并将会话元信息、消息历史和压缩记录持久化到文件系统
"""

import shutil
from typing import Dict, Optional, List
import uuid
import json
from pathlib import Path
from datetime import datetime

from utils.logger import logger
from memory.schema import Session, Message, CompressionHistory


class SessionManager:
    """
    会话管理器

    该类在 Agent 之上提供会话生命周期管理能力 包括缓存命中、
    文件加载与状态修复逻辑 确保会话数据在重启后可恢复。

    Args:
        storage_path (Path): 存在会话文件的目录路径

    Returns:
        SessionManager: SessionManager 实例
    """

    def __init__(self, storage_path: Path):
        """
        初始化会话管理器

        构造函数会校验存储路径并创建目录 同时初始化内存缓存

        Args:
            storage_path (Path): 存储会话数据的目录路径

        Returns:
            None

        Raises:
            ValueError: 当 storage_path 参数未提供时抛出

        Examples:
            >>> manager = SessionManager(Path("./data/sessions"))
        """
        if storage_path is None:
            raise ValueError("必须提供 storage_path 参数")

        self.storage_path = Path(storage_path)
        self.storage_path.mkdir(parents=True, exist_ok=True)

        # 内存缓存: key 为 session_id value 为会话对象
        self._cache: Dict[str, Session] = {}

        logger.info(f"✅ SessionManager 初始化完成，存储路径: {self.storage_path.absolute()}")

    def _get_session_dir(self, session_id: str) -> Path:
        """
        获取会话目录路径

        Args:
            session_id (str): 会话ID

        Returns:
            Path: 会话目录路径

        Examples:
            >>> path = manager._get_session_dir("abc123")
            >>> path.name
            'abc123'
        """
        return self.storage_path / session_id

    def _get_session_file(self, session_id: str) -> Path:
        """
        获取会话元信息文件路径

        Args:
            session_id (str): 会话ID

        Returns:
            Path: 会话元信息文件路径

        Examples:
            >>> path = manager._get_session_file("abc123")
            >>> path.name
            'session.json'
        """
        return self._get_session_dir(session_id) / "session.json"

    def _get_messages_file(self, session_id: str) -> Path:
        """
        获取消息文件路径

        Args:
            session_id (str): 会话ID

        Returns:
            Path: 消息文件路径

        Examples:
            >>> path = manager._get_messages_file("abc123")
            >>> path.name
            'messages.json'
        """
        return self._get_session_dir(session_id) / "messages.json"

    def _get_compression_file(self, session_id: str) -> Path:
        """
        获取压缩记录文件路径。

        Args:
            session_id (str): 会话ID

        Returns:
            Path: 压缩记录文件路径

        Examples:
            >>> path = manager._get_compression_file("abc123")
            >>> path.name
            'compression.json'
        """
        return self._get_session_dir(session_id) / "compression.json"

    def create_session(self, session_id: Optional[str] = None) -> Session:
        """
        创建并持久化新会话

        若未传入 session_id 则自动生成短 UUID

        Args:
            session_id (Optional[str]): 会话ID 默认为 None

        Returns:
            Session: 新创建的会话对象

        Examples:
            >>> session = manager.create_session()
            >>> session.session_id is not None
            True
        """
        # 创建会话对象 如果未提供 session_id 则生成一个随机的短 UUID 作为会话 ID
        session = Session(
            session_id=session_id or self._generate_id(),
            messages=[]
        )

        # 新建即落盘 确保会话在异常退出时也可恢复
        self.save_session(session)

        # 写入缓存 减少后续重复 I/O
        self._cache[session.session_id] = session

        logger.info(f"🆕 创建会话: {session.session_id}")
        return session

    def load_session(self, session_id: str) -> Optional[Session]:
        """
        从磁盘加载会话

        该方法按顺序读取元信息、消息历史与压缩记录

        任何阶段失败都会记录日志并返回 None

        Args:
            session_id (str): 会话ID

        Returns:
            Optional[Session]: 成功加载的会话对象或 None

        Examples:
            >>> session = manager.load_session("abc123")
        """
        # 先获取 Session 元信息路径并验证存在性 避免不必要的 I/O 操作
        session_file = self._get_session_file(session_id)

        if not session_file.exists():
            return None

        try:
            # 加载会话元信息
            with open(session_file, "r", encoding="utf-8") as f:
                session_data = json.load(f)

            session = Session.from_dict(session_data)

            # 加载消息历史
            messages_file = self._get_messages_file(session_id)
            if messages_file.exists():
                with open(messages_file, "r", encoding="utf-8") as f:
                    messages_data = json.load(f)
                session.messages = [
                    Message.from_dict(m) for m in messages_data
                ]

            # 加载压缩记录
            compression_file = self._get_compression_file(session_id)
            if compression_file.exists():
                try:
                    with open(compression_file, "r", encoding="utf-8") as f:
                        compression_data = json.load(f)
                    session.compression_history = CompressionHistory.from_dict(compression_data)
                except Exception as e:
                    logger.warning(f"⚠️ 压缩记录加载失败: {e}")

            # 放入缓存中 提升后续访问性能
            self._cache[session_id] = session
            logger.info(f"📂 加载会话: {session_id} ({len(session.messages)} 条消息)")
            return session

        except Exception as e:
            logger.error(f"❌ 加载会话失败 [{session_id}]: {e}")
            return None

    def get_or_create_session(self, session_id: str = None) -> Session:
        """
        获取会话 不存在则创建

        该方法优先查缓存 再查文件系统 若均不存在则创建新会话

        加载成功后会执行一次不完整状态清理

        Args:
            session_id (str): 会话ID 默认为 None

        Returns:
            Session: 获取或创建的会话对象

        Examples:
            >>> session = manager.get_or_create_session("demo")
            >>> session.session_id == "demo"
            True
        """
        # 优先从缓存中找
        if session_id in self._cache:
            session = self._cache[session_id]
            logger.info(f"📂 从缓存加载会话: {session_id}")
        else:
            # 缓存未命中时从磁盘加载
            session = self.load_session(session_id)

            if not session:
                session = self.create_session(session_id)
                return session

            # 清理可能残留的不完整 tool_call 状态并回写缓存
            session = self._cleanup_incomplete_state(session)
            self._cache[session_id] = session
            logger.info(f"📂 从文件加载会话: {session_id}")

        return session

    def save_session(self, session: Session):
        """
        保存会话全部数据

        该方法会刷新更新时间 并分别写入元信息 消息和压缩记录三个文件

        Args:
            session (Session): 需要保存的会话对象

        Returns:
            None

        Examples:
            >>> manager.save_session(session)
        """
        # 刷新更新时间 反映最新修改时间点
        session.updated_at = datetime.now().isoformat()

        # 确保会话目录存在
        session_dir = self._get_session_dir(session.session_id)
        session_dir.mkdir(parents=True, exist_ok=True)

        # 分文件写入 避免单文件结构过大难维护
        self._save_session_meta(session)
        self._save_messages(session)
        self._save_compression(session)

        logger.debug(f"💾 保存会话: {session.session_id}")

    def _save_session_meta(self, session: Session):
        """
        保存会话元信息

        Args:
            session (Session): 会话类

        Returns:
            None

        Examples:
            >>> manager._save_session_meta(session)
        """
        # 获取会话元信息文件路径并写入 JSON 格式数据
        session_file = self._get_session_file(session.session_id)
        with open(session_file, "w", encoding="utf-8") as f:
            json.dump(session.to_dict(), f, ensure_ascii=False, indent=2)

    def _save_messages(self, session: Session):
        """
        保存会话消息历史

        Args:
            session (Session): 会话类

        Returns:
            None

        Examples:
            >>> manager._save_messages(session)
        """
        # 获取消息文件路径并写入消息列表的 JSON 格式数据
        messages_file = self._get_messages_file(session.session_id)
        messages_data = [m.to_dict() for m in session.messages]

        # 写入
        with open(messages_file, "w", encoding="utf-8") as f:
            json.dump(messages_data, f, ensure_ascii=False, indent=2)

    def _save_compression(self, session: Session):
        """
        保存压缩历史记录

        Args:
            session (Session): 会话类

        Returns:
            None

        Examples:
            >>> manager._save_compression(session)
        """
        # 获取压缩记录文件路径并写入压缩历史的 JSON 格式数据
        compression_file = self._get_compression_file(session.session_id)
        with open(compression_file, "w", encoding="utf-8") as f:
            json.dump(
                session.compression_history.to_dict(),
                f,
                ensure_ascii=False,
                indent=2
            )

    def delete_session(self, session_id: str) -> bool:
        """
        删除会话及其目录数据

        Args:
            session_id (str): 会话ID

        Returns:
            bool: 删除成功返回 True 会话不存在或删除失败返回 False

        Examples:
            >>> ok = manager.delete_session("demo")
        """
        # 获取会话目录路径并验证存在性 避免不必要的 I/O 操作
        session_dir = self._get_session_dir(session_id)

        if not session_dir.exists():
            return False

        try:
            # 物理删除会话目录 shutil.rmtree 会递归删除整个目录及其内容 包括 session.json messages.json compression.json 等所有文件
            shutil.rmtree(session_dir)

            # 同步移除缓存中的会话对象 避免后续访问时出现残留数据
            if session_id in self._cache:
                del self._cache[session_id]

            logger.info(f"🗑️ 删除会话: {session_id}")
            return True

        except Exception as e:
            logger.error(f"❌ 删除会话失败 [{session_id}]: {e}")
            return False

    def list_sessions(self) -> List[Dict]:
        """
        列出当前存储目录下的会话

        该方法扫描包含 `session.json` 的子目录并返回排序结果

        Args:
            None

        Returns:
            List[Dict]: 会话列表 每个元素包含 session_id 和 updated_at 字段

        Examples:
            >>> sessions = manager.list_sessions()
        """
        sessions = []

        # 仅将具备 session.json 的目录识别为有效会话
        for item in self.storage_path.iterdir():
            if item.is_dir() and (item / "session.json").exists():
                sessions.append(item.name)

        return sorted(sessions)

    def clear_cache(self) -> None:
        """
        清空内存缓存

        Args:
            None

        Returns:
            None

        Examples:
            >>> manager.clear_cache()
        """
        self._cache.clear()
        logger.info("🧹 清理Session会话缓存完成")

    def _cleanup_incomplete_state(self, session: Session) -> Session:
        """
        清理不完整的 tool_call 会话状态

        当最后一条 assistant 消息包含 tool_calls 但缺少对应 tool 响应时

        该方法会回滚该 assistant 消息之后的无效片段

        Args:
            session (Session): 会话类对象

        Returns:
            Session: 清理后的会话对象

        Examples:
            >>> fixed = manager._cleanup_incomplete_state(session)
            >>> isinstance(fixed, Session)
            True
        """
        # 如果没有消息 则无需清理 直接返回原会话对象 避免不必要的处理
        if not session.messages:
            return session

        # 检查最后一条消息是否为带 tool_calls 的 assistant 消息
        last_msg = session.messages[-1]

        if last_msg.role == "assistant" and last_msg.tool_calls:
            tool_call_ids = {tc["id"] for tc in last_msg.tool_calls}

            # 从尾部反向扫描 收集该 assistant 之后已返回的 tool_call_id
            found_responses = set()
            for i in range(len(session.messages) - 1, -1, -1):
                msg = session.messages[i]
                if msg.role == "assistant" and msg.tool_calls:
                    break
                if msg.role == "tool" and msg.tool_call_id:
                    found_responses.add(msg.tool_call_id)

            # 存在未响应 tool_call 时 裁剪掉该不完整段落
            if tool_call_ids - found_responses:
                for i in range(len(session.messages) - 1, -1, -1):
                    if session.messages[i] == last_msg:
                        session.messages = session.messages[:i]
                        logger.info("🔧 清理了不完整的 tool_call 消息")
                        break

        return session

    def _generate_id(self) -> str:
        """
        生成短会话 ID

        Args:
            None

        Returns:
            str: 长度为 8 的随机字符串

        Examples:
            >>> sid = manager._generate_id()
            >>> len(sid)
            8
        """
        return str(uuid.uuid4())[:8]
