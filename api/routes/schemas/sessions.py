from typing import List

from pydantic import BaseModel


class SessionInfo(BaseModel):
    """
    会话信息模型

    - id (str): 会话标识
    - created_at (str): 创建时间
    - updated_at (str): 更新时间
    - last_message_at (str): 最近消息时间
    - message_count (int): 消息数量
    """

    id: str
    created_at: str
    updated_at: str
    last_message_at: str
    message_count: int


class SessionListResponse(BaseModel):
    """
    会话列表响应模型

    - sessions (List[SessionInfo]): 会话列表
    """

    sessions: List[SessionInfo]


class MessageInfo(BaseModel):
    """
    消息信息模型

    - role (str): 消息角色
    - content (str): 消息内容
    - timestamp (str): 时间戳
    """

    role: str
    content: str
    timestamp: str


class MessagesResponse(BaseModel):
    """
    消息列表响应模型

    - messages (List[MessageInfo]): 消息列表
    """

    messages: List[MessageInfo]


class RenameRequest(BaseModel):
    """
    会话重命名请求模型

    - new_name (str): 新会话名称
    """

    new_name: str


class NewSessionRequest(BaseModel):
    """
    新建会话请求模型

    - session_id (str): 期望会话名称
    """

    session_id: str
