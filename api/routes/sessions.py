"""
会话路由模块

该模块提供会话列表 创建 删除 重命名 与消息读取接口
"""

from typing import List
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.services.session_service import get_session_service

router = APIRouter()


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


@router.get("/sessions", response_model=SessionListResponse)
async def list_sessions():
    """
    获取会话列表

    Args:
        None

    Returns:
        SessionListResponse: 会话列表响应
    """
    service = get_session_service()
    sessions_data = service.list_sessions()

    # 映射服务层字典为响应模型
    sessions = [
        SessionInfo(
            id=s["id"],
            created_at=s["created_at"],
            updated_at=s["updated_at"],
            last_message_at=s["updated_at"],
            message_count=s["message_count"],
        )
        for s in sessions_data
    ]
    return SessionListResponse(sessions=sessions)


@router.post("/sessions/new")
async def create_new_session(request: NewSessionRequest):
    """
    创建新会话

    Args:
        request (NewSessionRequest): 新建会话请求体

    Returns:
        Dict[str str]: 创建结果字典
    """
    service = get_session_service()
    # 创建目录与会话元数据文件
    session = service.create_new_session(request.session_id)
    return {
        "status": "created",
        "session_id": session.session_id,
        "title": session.session_id,
    }


@router.get("/sessions/{session_id}/messages", response_model=MessagesResponse)
async def get_session_messages(session_id: str):
    """
    获取指定会话消息

    Args:
        session_id (str): 会话标识

    Returns:
        MessagesResponse: 消息列表响应
    """
    service = get_session_service()
    messages_data = service.get_session_messages(session_id)
    # 映射消息字段到响应模型
    messages = [
        MessageInfo(role=m["role"], content=m["content"], timestamp=m["timestamp"])
        for m in messages_data
    ]
    return MessagesResponse(messages=messages)


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """
    删除指定会话

    Args:
        session_id (str): 会话标识

    Returns:
        Dict[str str]: 删除结果字典

    Raises:
        HTTPException: 当会话不存在时抛出 404
    """
    service = get_session_service()
    if service.delete_session(session_id):
        return {"status": "deleted", "session_id": session_id}
    raise HTTPException(status_code=404, detail="Session not found")


@router.post("/sessions/{session_id}/rename")
async def rename_session(session_id: str, request: RenameRequest):
    """
    重命名会话

    Args:
        session_id (str): 原会话标识
        request (RenameRequest): 重命名请求体

    Returns:
        Dict[str str]: 重命名结果字典

    Raises:
        HTTPException: 当会话不存在或名称冲突时抛出 404
    """
    service = get_session_service()
    if service.rename_session(session_id, request.new_name):
        return {"status": "renamed", "session_id": session_id, "new_id": request.new_name}
    raise HTTPException(status_code=404, detail="Session not found or name conflict")
