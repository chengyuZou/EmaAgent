"""
会话服务模块

该模块提供独立会话管理入口
负责创建 删除 重命名 列表读取 与消息读取
"""
import json
import shutil
from datetime import datetime
from typing import Optional, List, Dict, Any
from pathlib import Path
from threading import Lock

from config.paths import get_paths
from memory.manager import SessionManager
from memory.schema import Session


class SessionService:
    """
    会话服务单例类

    该类对 SessionManager 做服务层封装
    统一向路由层暴露会话相关操作
    """
    _instance: Optional["SessionService"] = None
    _lock = Lock()

    def __new__(cls):
        """
        创建或返回单例对象
        """
        # 使用双重检查锁避免并发重复初始化
        # 首次访问时尝试创建实例
        if cls._instance is None:
            with cls._lock:
                # 进入锁后再次确认实例状态
                if cls._instance is None:
                    # 真正分配对象内存并设置初始化标记
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        """
        初始化服务对象
        """
        # 单例重复构造时直接返回
        # 已初始化时直接退出 防止重复设置属性
        if self._initialized:
            return
        # 管理器延迟初始化 用于支持配置重载
        self._manager: Optional[SessionManager] = None
        # 记录重命名映射，解决流式回复过程中改名后写回旧 ID 的并发问题
        self._renamed_ids: Dict[str, str] = {}
        self._initialized = True

    @property
    def manager(self) -> SessionManager:
        """
        获取底层会话管理器

        Args:
            None

        Returns:
            SessionManager: 会话管理器对象
        """
        # 首次访问时读取 paths 并创建管理器
        if self._manager is None:
            # 读取最新路径配置 保证会话目录可切换
            paths = get_paths()
            # 传入 storage_path 让 manager 负责具体文件组织
            self._manager = SessionManager(storage_path=paths.sessions_dir)
        return self._manager

    def reload(self):
        """
        重置管理器缓存
        """
        # 下次访问 manager 时会重新初始化
        # 清空 manager 引用 强制后续请求重新绑定路径
        self._manager = None

    def _resolve_session_id(self, session_id: str) -> str:
        """
        解析会话最新 ID（处理重命名链）。
        """
        current = session_id
        visited = set()
        while current in self._renamed_ids and current not in visited:
            visited.add(current)
            current = self._renamed_ids[current]
        return current

    def get_or_create_session(self, session_id: str) -> Session:
        """
        获取或创建会话

        Args:
            session_id (str): 会话标识

        Returns:
            Session: 会话对象
        """
        session_id = self._resolve_session_id(session_id)
        # 直接委托底层管理器处理缓存与落盘逻辑
        # 由 manager 统一处理 不在服务层重复实现
        return self.manager.get_or_create_session(session_id)

    def save_session(self, session: Session):
        """
        保存会话数据

        Args:
            session (Session): 会话对象

        Returns:
            None
        """
        # 若会话在运行中被重命名，统一写回到新 ID，避免生成旧目录造成重复会话
        original_id = session.session_id
        resolved_id = self._resolve_session_id(original_id)
        if resolved_id != original_id:
            session.session_id = resolved_id
            if original_id in self.manager._cache:
                del self.manager._cache[original_id]
            self.manager._cache[resolved_id] = session
            # 重定向完成后清理一次性映射，避免长期占用旧 ID
            self._renamed_ids.pop(original_id, None)

        # 统一走 manager 保存
        # 调用底层保存接口 触发 session 与 messages 落盘
        self.manager.save_session(session)

    def create_new_session(self, session_id: str) -> Session:
        """
        创建新会话并确保目录文件就绪

        Args:
            session_id (str): 期望会话标识

        Returns:
            Session: 新建会话对象
        """
        # 获取会话根目录路径
        paths = get_paths()
        sessions_dir = paths.sessions_dir

        # 同名冲突时追加时分秒后缀
        final_id = session_id
        if (sessions_dir / final_id).exists():
            # 使用当前时间尾缀避免目录名冲突
            final_id = f"{session_id}_{datetime.now().strftime('%H%M%S')}"

        # 创建会话对象
        session = self.manager.create_session(final_id)

        # 主动保存并写入缓存 保证后续读取一致
        self.manager.save_session(session)
        # 直接更新内存缓存 减少下次查询磁盘开销
        self.manager._cache[final_id] = session
        return session

    def delete_session(self, session_id: str) -> bool:
        """
        删除指定会话目录与缓存

        Args:
            session_id (str): 会话标识

        Returns:
            bool: 是否删除成功
        """
        session_id = self._resolve_session_id(session_id)
        # 解析会话目录路径
        paths = get_paths()
        session_path = paths.sessions_dir / session_id
        # 仅在目录存在时继续删除流程
        if session_path.exists():
            try:
                # 删除整个会话目录
                shutil.rmtree(session_path)
                # 同步删除缓存项
                if session_id in self.manager._cache:
                    del self.manager._cache[session_id]
                return True
            except Exception:
                # 删除失败统一返回 False 由上层决定提示
                return False
        return False

    def list_sessions(self) -> List[Dict[str, Any]]:
        """
        列出全部会话摘要

        Args:
            None:

        Returns:
            List[Dict[str Any]]: 会话摘要列表 按更新时间倒序
        """
        # 读取会话目录配置
        paths = get_paths()
        sessions_dir = paths.sessions_dir
        sessions = []

        # 会话目录不存在时返回空列表
        if not sessions_dir.exists():
            return sessions

        # 遍历目录读取每个会话
        for session_dir in sessions_dir.iterdir():
            if not session_dir.is_dir():
                # 跳过非目录文件
                continue
            try:
                # 使用 manager 加载 保证数据结构一致
                session = self.manager.get_or_create_session(session_dir.name)

                # 标题使用 session_id 避免旧数据 title 不可靠
                title = session.session_id

                sessions.append({
                    "id": session.session_id,
                    "title": title,
                    "created_at": (session.created_at.isoformat()
                                   if hasattr(session.created_at, 'isoformat')
                                   else str(session.created_at)),
                    "updated_at": (session.updated_at.isoformat()
                                   if hasattr(session.updated_at, 'isoformat')
                                   else str(session.updated_at)),
                    "message_count": len(session.messages),
                })
            except Exception as e:
                # 保留错误打印 便于排查坏会话文件
                print(f"❌ 读取 Session 错误 {session_dir.name}: {e}")
                import traceback
                traceback.print_exc()

        # 前端显示按最近更新时间排序
        sessions.sort(key=lambda s: s["updated_at"], reverse=True)
        return sessions

    def get_session_messages(self, session_id: str) -> List[Dict[str, Any]]:
        """
        获取会话消息列表

        仅返回 user 与 assistant 消息

        Args:
            session_id (str): 会话标识

        Returns:
            List[Dict[str Any]]: 消息字典列表
        """
        try:
            session_id = self._resolve_session_id(session_id)
            # 加载会话后转换为前端所需字段
            session = self.manager.get_or_create_session(session_id)
            filtered_messages: List[Dict[str, Any]] = []
            for msg in session.messages:
                # 仅输出 user 与 assistant
                if msg.role not in ["user", "assistant"]:
                    continue

                # 跳过带 tool_calls 的 assistant 思考片段 避免前端显示内部推理
                if msg.role == "assistant" and getattr(msg, "tool_calls", None):
                    continue

                filtered_messages.append(
                    {
                        # role 用于前端区分消息气泡方向
                        "role": msg.role,
                        # content 保留原始文本 不做摘要压缩
                        "content": msg.content,
                        # timestamp 统一输出字符串 兼容多种时间类型
                        "timestamp": (msg.timestamp.isoformat()
                                      if hasattr(msg.timestamp, 'isoformat')
                                      else str(msg.timestamp)),
                    }
                )
            return filtered_messages
        except Exception:
            # 任意异常时返回空列表 保持接口稳定
            return []

    def rename_session(self, session_id: str, new_name: str) -> bool:
        """
        重命名会话目录并同步 session.json

        Args:
            session_id (str): 原会话标识
            new_name (str): 新会话标识

        Returns:
            bool: 是否重命名成功
        """
        try:
            session_id = self._resolve_session_id(session_id)
            # 计算旧目录与新目录
            paths = get_paths()
            old_dir = paths.sessions_dir / session_id
            new_dir = paths.sessions_dir / new_name

            # 原目录不存在直接失败
            if not old_dir.exists():
                return False
            # 同名改名视为成功
            if session_id == new_name:
                return True
            # 新名称冲突直接失败
            if new_dir.exists():
                return False

            # 1 执行目录重命名
            old_dir.rename(new_dir)

            # 2 更新 session.json 内 session_id 与可选 title
            session_file = new_dir / "session.json"
            if session_file.exists():
                # 读取原始 session 元数据
                with open(session_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                # 覆盖会话标识 保证文件内容与目录一致
                data["session_id"] = new_name
                if "title" in data:
                    # title 存在时同步更新显示名称
                    data["title"] = new_name
                # 写回磁盘并保留中文
                with open(session_file, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)

            # 3 更新缓存与重命名映射
            cached_session = self.manager._cache.pop(session_id, None)
            if cached_session is not None:
                cached_session.session_id = new_name
                self.manager._cache[new_name] = cached_session

            # 记录 old -> new，确保流式中的旧 session 对象保存时回写到新目录
            self._renamed_ids[session_id] = new_name
            # 压扁映射链条
            for old_id, current_id in list(self._renamed_ids.items()):
                if current_id == session_id:
                    self._renamed_ids[old_id] = new_name

            return True
        except Exception as e:
            # 打印异常细节方便快速定位问题
            print(f"❌ 重新命名 Session 失败: {e}")
            return False

    def auto_rename_from_first_message(self, session_id: str, message: str) -> bool:
        """
        按首条消息自动生成标题并重命名

        Args:
            session_id (str): 原会话标识
            message (str): 用户消息文本

        Returns:
            bool: 是否自动重命名成功
        """
        # 截取前 20 字作为标题 超长追加省略标记
        # 生成简短标题 过长时使用省略标记
        title = message[:20] + ("..." if len(message) > 20 else "")
        # 复用统一重命名流程
        return self.rename_session(session_id, title)


_session_service: Optional[SessionService] = None

def get_session_service() -> SessionService:
    """
    获取会话服务全局单例

    Args:
        None:

    Returns:
        SessionService: 全局会话服务对象
    """
    global _session_service
    # 延迟初始化全局实例
    if _session_service is None:
        # 首次调用时创建服务实例
        _session_service = SessionService()
    return _session_service
